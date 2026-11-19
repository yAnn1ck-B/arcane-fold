import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../src/lib/deck-autosave.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
});
const { CollectionAddBases, DeckAutosave } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const draft = (quantity = 1, id = null, name = 'Named deck', cardId = 'front') => ({
  id, name, cards: quantity ? [{ cardId, section: 'main', quantity }] : [],
});
const detail = (request, id = request.id ?? 'created-id') => ({
  ...request, id, createdAt: 'today', updatedAt: 'today',
});
function fixture(save) {
  const calls = [], tokens = [], states = [], acks = [];
  const queue = new DeckAutosave(async (value, token) => {
    calls.push(structuredClone(value));
    tokens.push(token);
    return save ? save(value, calls.length, token) : detail(value);
  }, (state) => states.push(state), (ack) => acks.push(ack), 0);
  return { queue, calls, tokens, states, acks };
}

test('opening the editor and an unnamed first edit never create a junk deck', async () => {
  const { queue, calls, states } = fixture();
  queue.reset({ id: null, name: '', cards: [] });
  await tick();
  assert.equal(calls.length, 0);
  queue.edit(draft(1, null, ''));
  await tick();
  assert.equal(calls.length, 0);
  assert.equal(states.at(-1).phase, 'unnamed');
  await assert.rejects(queue.flush(), /Name this deck/);
  queue.edit(draft(1, null, 'My first deck'));
  await queue.flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'My first deck');
});

test('rapid edits serialize a first create and reuse its assigned ID for the newest snapshot', async () => {
  const first = deferred();
  let active = 0, maximum = 0;
  const { queue, calls } = fixture(async (value, count) => {
    maximum = Math.max(maximum, ++active);
    const result = count === 1 ? await first.promise : detail(value);
    active--;
    return result;
  });
  queue.edit(draft(1));
  const flushing = queue.flush();
  queue.edit(draft(2));
  queue.edit(draft(3));
  assert.equal(calls.length, 1);
  first.resolve(detail(calls[0], 'one-logical-deck'));
  await flushing;
  assert.equal(maximum, 1);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].id, null);
  assert.equal(calls[1].id, 'one-logical-deck');
  assert.equal(calls[1].cards[0].quantity, 3);
  assert.equal(queue.getDraft().id, 'one-logical-deck');
});

test('a stale response acknowledges identity without erasing a later name or printing change', async () => {
  const first = deferred();
  const { queue, calls, acks } = fixture((value, count) => count === 1 ? first.promise : detail(value));
  queue.reset(draft(1, 'existing'));
  queue.edit(draft(2, 'existing'));
  const flushing = queue.flush();
  queue.edit(draft(2, 'existing', 'Renamed', 'alternate-printing'));
  first.resolve(detail(calls[0]));
  await flushing;
  assert.deepEqual(acks.map((ack) => ack.current), [false, true]);
  assert.equal(queue.getDraft().name, 'Renamed');
  assert.equal(queue.getDraft().cards[0].cardId, 'alternate-printing');
  assert.equal(calls[1].name, 'Renamed');
});

test('a save error pauses without a retry loop and explicit Retry sends only the latest draft', async () => {
  const { queue, calls, states } = fixture((value, count) => {
    if (count === 1) throw new Error('Server unavailable');
    return detail(value);
  });
  queue.reset(draft(1, 'existing'));
  queue.edit(draft(2, 'existing'));
  await assert.rejects(queue.flush(), /Server unavailable/);
  await tick();
  await tick();
  assert.equal(calls.length, 1);
  assert.equal(states.at(-1).phase, 'error');
  assert.equal(queue.getDraft().cards[0].quantity, 2);
  await queue.flush();
  assert.equal(calls.length, 2);
  assert.equal(states.at(-1).pending, false);
});

test('a new edit resumes a failed queue once without replaying obsolete intermediate drafts', async () => {
  const { queue, calls } = fixture((value, count) => {
    if (count === 1) throw new Error('temporary failure');
    return detail(value);
  });
  queue.edit(draft(1));
  await assert.rejects(queue.flush());
  queue.edit(draft(2));
  queue.edit(draft(4));
  await queue.flush();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].cards[0].quantity, 4);
});

test('a failed transition flush leaves the current editor session untouched', async () => {
  const { queue } = fixture(() => { throw new Error('permission denied'); });
  queue.reset(draft(1, 'current'));
  queue.edit(draft(3, 'current'));
  await assert.rejects(async () => {
    await queue.flush();
    queue.reset(draft(1, 'other'));
  }, /permission denied/);
  assert.equal(queue.getDraft().id, 'current');
  assert.equal(queue.getDraft().cards[0].quantity, 3);
});

test('suspending deletion waits for an active save and cancels the buffered follow-up', async () => {
  const first = deferred();
  const { queue, calls } = fixture(() => first.promise);
  queue.reset(draft(1, 'existing'));
  queue.edit(draft(2, 'existing'));
  const saving = queue.flush().catch((error) => error);
  queue.edit(draft(3, 'existing'));
  let settled = false;
  const deleting = queue.suspend().then(() => { settled = true; });
  await tick();
  assert.equal(settled, false);
  first.resolve(detail(calls[0]));
  await deleting;
  queue.reset({ id: null, name: '', cards: [] });
  await saving;
  await tick();
  assert.equal(calls.length, 1);
  assert.equal(queue.getDraft().id, null);
});

test('session invalidation ignores old acknowledgements and still serializes a replacement', async () => {
  const first = deferred();
  const { queue, calls, acks } = fixture((value, count) => count === 1 ? first.promise : detail(value));
  queue.edit(draft(1));
  const saving = queue.flush();
  queue.reset(draft(1, 'replacement'));
  queue.edit(draft(4, 'replacement'));
  first.resolve(detail(calls[0], 'old-created-id'));
  await saving;
  assert.equal(calls.length, 2);
  assert.equal(calls[1].id, 'replacement');
  assert.deepEqual(acks.map((ack) => ack.deck.id), ['replacement']);
});

test('unchanged persisted fields do not save again after ownership metadata refresh', async () => {
  const { queue, calls } = fixture();
  queue.reset(draft(2, 'existing'));
  queue.edit(structuredClone(draft(2, 'existing')));
  await queue.flush();
  assert.equal(calls.length, 0);
});

test('explicitly creating a named empty deck is saved even without card changes', async () => {
  const { queue, calls } = fixture();
  queue.reset(draft(0, null, 'New deck'));
  queue.edit(draft(0, null, 'New deck'), true);
  await queue.flush();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].cards, []);
});

test('a first-create retry keeps its creation token until the server ID is acknowledged', async () => {
  const { queue, calls, tokens } = fixture((value, count) => {
    if (count === 1) throw new Error('reply unavailable after commit');
    return detail(value, 'same-created-deck');
  });
  queue.edit(draft(1));
  await assert.rejects(queue.flush());
  queue.edit(draft(2));
  await queue.flush();
  assert.ok(tokens[0]);
  assert.equal(tokens[1], tokens[0]);
  assert.equal(calls[1].id, null);
  queue.edit(draft(3));
  await queue.flush();
  assert.equal(calls[2].id, 'same-created-deck');
  assert.equal(tokens[2], undefined);
  queue.reset({ id: null, name: '', cards: [] });
  queue.edit(draft(1));
  await queue.flush();
  assert.notEqual(tokens[3], tokens[0]);
});

test('canceling first unnamed creation resets its proposed cards without a server write', async () => {
  const { queue, calls } = fixture();
  queue.edit(draft(1, null, ''));
  queue.reset({ id: null, name: '', cards: [] });
  await queue.flush();
  assert.equal(calls.length, 0);
  assert.deepEqual(queue.getDraft().cards, []);
});

test('edited Add retries and target switches retain the original base after lost replies', () => {
  const bases = new CollectionAddBases();
  const original = { quantity: 0, cards: [] };
  const base = bases.capture('request', 'target-a', original);
  original.quantity = 99;
  assert.equal(base.quantity, 0);
  // First Add1 committed remotely, but its reply was lost. Choosing2 replaces
  // that logical addition; it must not use the now-persisted1 as a new base.
  assert.equal(bases.capture('request', 'target-a', { quantity: 1 }).quantity + 2, 2);
  bases.capture('request', 'target-b', { quantity: 8 });
  assert.equal(bases.get('request', 'target-b').quantity, 8);
  // Switching away/back after another lost reply must still allow the full4.
  assert.equal(bases.capture('request', 'target-a', { quantity: 2 }).quantity + 4, 4);
  assert.equal(bases.capture('request', 'target-a', { quantity: 4 }).quantity + 4, 4);
});

test('Add bases distinguish requests and preserve the empty new-target base', () => {
  const bases = new CollectionAddBases();
  assert.equal(bases.capture('one', 'new', null), null);
  assert.equal(bases.capture('one', 'new', { quantity: 1 }), null);
  bases.capture('one', 'existing', { quantity: 1 });
  assert.equal(bases.capture('two', 'existing', { quantity: 4 }).quantity, 4);
  bases.clear();
  assert.equal(bases.get('one', 'existing'), undefined);
});
