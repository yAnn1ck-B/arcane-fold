import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import pg from 'pg';
import { activeAccount, allowsLocalPlay, seedAccounts, signIn, signOut } from './accounts.mjs';

test('passwordless player selection requires a direct loopback installation and request', () => {
  const direct = { socket: { remoteAddress: '127.0.0.1' }, headers: {} };
  const local = new URL('http://localhost:4317');
  assert.equal(allowsLocalPlay(direct, local, '127.0.0.1'), process.env.WEB_LOCAL_PLAY !== '0');
  assert.equal(allowsLocalPlay(direct, local, '0.0.0.0'), false);
  assert.equal(allowsLocalPlay(direct, new URL('https://game.example'), '127.0.0.1'), false);
  assert.equal(allowsLocalPlay({ ...direct, socket: { remoteAddress: '192.0.2.7' } }, local, '127.0.0.1'), false);
  assert.equal(allowsLocalPlay({ ...direct, headers: { 'x-forwarded-for': '127.0.0.1' } }, local, '127.0.0.1'), false);
});

test('seeded logins survive migrations, retain legacy progress and isolate browser sessions', {
  skip: !process.env.DATABASE_URL && !process.env.PGDATABASE,
}, async t => {
  const db = new pg.Client(process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : {});
  const directory = await mkdtemp(path.join(tmpdir(), 'arcane-fold-accounts-'));
  const file = path.join(directory, 'logins.json');
  t.after(() => rm(directory, { recursive: true, force: true }));
  await db.connect();
  t.after(async () => { try { await db.query('ROLLBACK'); } finally { await db.end(); } });
  await db.query('BEGIN');
  const schema = 'test_accounts_' + randomUUID().replaceAll('-', '');
  await db.query('CREATE SCHEMA ' + schema);
  await db.query('SET LOCAL search_path TO ' + schema);
  for (const sql of ['schema.sql', 'league.sql']) {
    await db.query(await readFile(new URL(sql, import.meta.url), 'utf8'));
  }
  await seedAccounts(db, file);
  const passwords = JSON.parse(await readFile(file, 'utf8'));
  const yannick = passwords.find(row => row.email === 'yannick@arcane-fold.test');
  const jef = passwords.find(row => row.email === 'jef@arcane-fold.test');
  assert.ok(yannick?.password && jef?.password && yannick.password !== jef.password);
  const accounts = () => db.query('SELECT name, password_hash FROM web_accounts ORDER BY name').then(result => result.rows);
  const seeded = await accounts();
  assert.deepEqual(seeded.map(row => row.name), ['Jef', 'Yannick']);
  assert.ok(seeded.every(row => row.password_hash !== yannick.password && row.password_hash !== jef.password));
  await seedAccounts(db, file);
  assert.deepEqual(await accounts(), seeded);

  const legacyToken = randomBytes(32).toString('hex');
  const legacyPlayer = randomUUID();
  await db.query('INSERT INTO web_players(id,session_hash) VALUES($1,$2)',
    [legacyPlayer, createHash('sha256').update(legacyToken).digest('hex')]);
  await db.query(`INSERT INTO web_receipts(player_id,request_id,kind,request,result)
    VALUES($1,'previous-opening','open','{}','{"spent":true}')`, [legacyPlayer]);
  await assert.rejects(signIn(db, { email: yannick.email, password: jef.password }, { legacyToken }), { status: 401 });
  assert.equal(await activeAccount(db, legacyToken), null);
  const host = await signIn(db, { ...yannick, email: yannick.email.toUpperCase() }, { legacyToken });
  assert.equal(host.playerId, legacyPlayer);
  assert.deepEqual(host.user, { name: 'Yannick', email: yannick.email });
  const otherBrowser = await signIn(db, yannick);
  assert.equal(otherBrowser.playerId, host.playerId);
  assert.ok(otherBrowser.token !== host.token);
  const guest = await signIn(db, { email: jef.email }, { local: true, legacyToken, previousToken: host.token });
  assert.equal(guest.user.name, 'Jef');
  assert.notEqual(guest.playerId, host.playerId);
  assert.equal((await activeAccount(db, guest.token)).player_id, guest.playerId);
  assert.equal(await activeAccount(db, host.token), null);
  assert.equal((await activeAccount(db, otherBrowser.token)).player_id, host.playerId);
  const receipts = await db.query('SELECT result FROM web_receipts WHERE player_id=$1', [host.playerId]);
  assert.deepEqual(receipts.rows, [{ result: { spent: true } }]);
  assert.equal((await db.query('SELECT 1 FROM web_receipts WHERE player_id=$1', [guest.playerId])).rowCount, 0);
  await signOut(db, guest.token);
  assert.equal(await activeAccount(db, guest.token), null);
  assert.equal((await signIn(db, jef)).playerId, guest.playerId);
});
