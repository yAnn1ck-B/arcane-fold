import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../src/lib/database-retry.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
});
const { retryDatabaseBusy, isDatabaseBusy, DATABASE_BUSY_RETRY_DELAYS_MS } =
  await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);

const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('SQLite busy/locked strings, extended codes and nested serialized driver errors are recognized', () => {
  for (const error of [
    new Error('error returned from database: (code: 5) database is locked'),
    'database is locked',
    'database table is locked: settings',
    'database schema is locked: main',
    'SQLITE_BUSY: another writer holds the file',
    'SQLITE_BUSY_SNAPSHOT',
    { code: 'SQLITE_LOCKED_SHAREDCACHE' },
    { cause: { Database: { code: '517', message: 'database is locked' } } },
    JSON.stringify({ Database: { code: '5', message: 'database is locked' } }),
    { error: JSON.stringify({ message: 'database\n is\n locked' }) },
  ]) assert.equal(isDatabaseBusy(error), true);
});

test('OS code 5, unrelated locks and missing error detail are never treated as SQLite contention', () => {
  for (const error of [
    5, '5', { code: 5 }, { code: '5' }, null, undefined, {},
    new Error('Access is denied. (os error 5)'),
    { code: 5, message: 'Access denied' },
    { code: 'EACCES', message: 'Cannot open file' },
    new Error('A card file is locked by another program'),
    new Error('The database connection was lost'),
    { query: "SELECT 'SQLITE_BUSY'", message: 'Query failed' },
    JSON.stringify({ query: "SELECT 'SQLITE_BUSY'", message: 'Query failed' }),
  ]) assert.equal(isDatabaseBusy(error), false);
});

test('permanent constraints, migration/checksum, corruption and permission failures override busy-looking wrappers', async () => {
  const permanent = [
    new Error('UNIQUE constraint failed: cards.id'),
    'SQLITE_CONSTRAINT_FOREIGNKEY',
    'Migration 1 was previously applied but has been modified',
    'migration checksum mismatch',
    'SQLITE_CORRUPT: database disk image is malformed',
    'file is not a database',
    'attempt to write a readonly database',
    'SQLITE_BUSY: Access denied',
    { code: 'SQLITE_BUSY', cause: new Error('Permission denied') },
    { message: 'database is locked', cause: { code: 'SQLITE_CONSTRAINT_CHECK' } },
    { message: 'database is locked', cause: new Error('checksum mismatch') },
  ];
  for (const error of permanent) {
    assert.equal(isDatabaseBusy(error), false);
    let calls = 0;
    await assert.rejects(retryDatabaseBusy(async () => { calls++; throw error; }, {
      sleep: async () => assert.fail('Permanent errors must not wait or retry'),
      onRetry: () => assert.fail('Permanent errors must not notify a retry'),
    }), value => value === error);
    assert.equal(calls, 1);
  }
});

test('transient contention retries sequentially and returns the successful result unchanged', async () => {
  const result = { ready: true };
  const errors = [new Error('database is locked'), 'SQLITE_BUSY'];
  const waits = [], notices = [];
  let calls = 0;
  const actual = await retryDatabaseBusy(async () => {
    const attempt = calls++;
    if (attempt < errors.length) throw errors[attempt];
    return result;
  }, { sleep: async delay => waits.push(delay), onRetry: notice => notices.push(notice) });
  assert.equal(actual, result);
  assert.equal(calls, 3);
  assert.deepEqual(waits, [250, 500]);
  assert.deepEqual(notices, [
    { attempt: 1, nextAttempt: 2, delayMs: 250, error: errors[0] },
    { attempt: 2, nextAttempt: 3, delayMs: 500, error: errors[1] },
  ]);
});

test('persistent contention has exactly six attempts and 6.75 seconds of injected backoff before rethrowing the original error', async () => {
  const error = new Error('database table is locked');
  let calls = 0;
  const waits = [];
  await assert.rejects(retryDatabaseBusy(async () => { calls++; throw error; }, {
    sleep: async delay => waits.push(delay),
  }), value => value === error);
  assert.equal(calls, 6);
  assert.deepEqual(waits, [...DATABASE_BUSY_RETRY_DELAYS_MS]);
  assert.equal(waits.reduce((total, delay) => total + delay, 0), 6750);
});

test('a lower attempt limit truncates the fixed delay budget without allowing unbounded caller retries', async () => {
  const error = 'SQLITE_LOCKED';
  let calls = 0;
  const waits = [];
  await assert.rejects(retryDatabaseBusy(async () => { calls++; throw error; }, {
    maxAttempts: 3, sleep: async delay => waits.push(delay),
  }), value => value === error);
  assert.equal(calls, 3);
  assert.deepEqual(waits, [250, 500]);
  for (const maxAttempts of [0, -1, 1.5, 7, Infinity, NaN]) {
    await assert.rejects(retryDatabaseBusy(async () => assert.fail('Invalid options must not invoke startup work'), {
      maxAttempts, sleep: async () => assert.fail('Invalid options must not schedule a timer'),
    }), RangeError);
  }
});

test('maxAttempts one and immediate success never schedule a wait or loading retry notice', async () => {
  const noRetry = {
    sleep: async () => assert.fail('No delay expected'),
    onRetry: () => assert.fail('No retry notice expected'),
  };
  const value = await retryDatabaseBusy(async () => 'ready', noRetry);
  assert.equal(value, 'ready');
  const error = new Error('database is locked');
  await assert.rejects(retryDatabaseBusy(async () => { throw error; }, { ...noRetry, maxAttempts: 1 }), item => item === error);
});

test('a pending operation and pending backoff cannot overlap another attempt', async () => {
  const first = deferred(), wait = deferred(), second = deferred();
  const waits = [];
  let calls = 0, completed = false;
  const promise = retryDatabaseBusy(async () => {
    calls++;
    return calls === 1 ? first.promise : second.promise;
  }, { sleep: async delay => { waits.push(delay); await wait.promise; } });
  promise.then(() => { completed = true; });
  await tick();
  assert.equal(calls, 1);
  assert.equal(completed, false);
  first.reject(new Error('database is locked'));
  await tick();
  assert.equal(calls, 1);
  assert.deepEqual(waits, [250]);
  wait.resolve();
  await tick();
  assert.equal(calls, 2);
  assert.equal(completed, false);
  second.resolve('ready');
  assert.equal(await promise, 'ready');
  await tick();
  assert.equal(calls, 2);
  assert.equal(completed, true);
});

test('a permanent error after a transient retry is rethrown immediately without consuming later delays', async () => {
  const finalError = new Error('migration checksum mismatch');
  let calls = 0;
  const waits = [];
  await assert.rejects(retryDatabaseBusy(async () => {
    if (++calls === 1) throw new Error('database is locked');
    throw finalError;
  }, { sleep: async delay => waits.push(delay) }), value => value === finalError);
  assert.equal(calls, 2);
  assert.deepEqual(waits, [250]);
});

test('cyclic/hostile error objects terminate safely without coercing arbitrary objects', () => {
  const cyclic = { message: 'database is locked' };
  cyclic.cause = cyclic;
  assert.equal(isDatabaseBusy(cyclic), true);
  assert.equal(isDatabaseBusy({ cause: cyclic, code: 'SQLITE_CORRUPT' }), false);
  const hostile = {
    toString() { assert.fail('Classifier must not stringify objects'); },
    get message() { throw new Error('accessor failure'); },
  };
  assert.equal(isDatabaseBusy(hostile), false);
  assert.equal(isDatabaseBusy({ code: 'SQLITE_BUSY', get cause() { throw new Error('unknown hidden error'); } }), false);
  assert.equal(isDatabaseBusy({ message: 'database is locked', errors: [...Array(16).fill({}), new Error('Permission denied')] }), false);
});
