import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkMigrations, validateMigrationBytes } from './check-migrations.mjs';

function temporaryDirectory(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'eternal-league-migration-test-'));
  t.after(() => {
    const resolved = path.resolve(directory);
    if (path.dirname(resolved) !== path.resolve(tmpdir()) || !path.basename(resolved).startsWith('eternal-league-migration-test-')) throw new Error('Unsafe migration-test cleanup path.');
    rmSync(resolved, { recursive: true, force: true });
  });
  return directory;
}

test('migration validation accepts LF and rejects CRLF, mixed endings, and lone CR', () => {
  validateMigrationBytes(Buffer.from('CREATE TABLE cards(id TEXT);\n'));
  // The existing committed migration7 BOM is part of its canonical checksum.
  validateMigrationBytes(Buffer.from('\ufeffSELECT 1;\n'));
  for (const source of ['SELECT 1;\r\n', 'SELECT 1;\nSELECT 2;\r\n', 'SELECT 1;\rSELECT 2;']) {
    assert.throws(() => validateMigrationBytes(Buffer.from(source)), /CR\/CRLF/);
  }
});

test('version guard checks migration files before a release can be prepared', (t) => {
  const directory = temporaryDirectory(t);
  const migrations = path.join(directory, 'src-tauri/migrations');
  mkdirSync(migrations, { recursive: true });
  const file = path.join(migrations, '001_initial.sql');
  writeFileSync(file, 'CREATE TABLE cards(id TEXT);\n');
  assert.equal(checkMigrations(directory), 1);
  writeFileSync(file, 'CREATE TABLE cards(id TEXT);\r\n');
  assert.throws(() => checkMigrations(directory), /001_initial\.sql contains CR\/CRLF/);
});

test('Git checkout with core.autocrlf=true keeps SQL byte-identical and LF-only', (t) => {
  const directory = temporaryDirectory(t);
  const run = (...args) => {
    const result = spawnSync('git', ['-c', 'core.autocrlf=true', '-c', 'core.safecrlf=false', ...args], { cwd: directory, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    return result.stdout;
  };
  run('init', '--quiet');
  writeFileSync(path.join(directory, '.gitattributes'), readFileSync(new URL('../.gitattributes', import.meta.url)));
  const migrations = path.join(directory, 'src-tauri/migrations');
  mkdirSync(migrations, { recursive: true });
  const sql = Buffer.from('CREATE TABLE retained(id TEXT);\n-- Exact checksum bytes matter.\n');
  writeFileSync(path.join(migrations, '001_initial.sql'), sql);
  run('add', '.gitattributes', 'src-tauri/migrations/001_initial.sql');
  mkdirSync(path.join(directory, 'checkout'));
  run('checkout-index', '--all', '--force', '--prefix=checkout/');
  const checkedOut = readFileSync(path.join(directory, 'checkout/src-tauri/migrations/001_initial.sql'));
  assert.deepEqual(checkedOut, sql);
  validateMigrationBytes(checkedOut);
});
