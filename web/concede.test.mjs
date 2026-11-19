import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import { localTestPlayers } from './fixtures/players.mjs';
import { applyMove, readSeatPosition } from './rooms.mjs';

test('competing concessions finish once, from either seat, during a pending decision', {
  skip: !process.env.DATABASE_URL && !process.env.PGDATABASE,
}, async t => {
  const connection = process.env.DATABASE_URL ? {connectionString:process.env.DATABASE_URL} : {};
  const admin = new pg.Client(connection);
  await admin.connect();
  const schema = 'test_concede_' + randomUUID().replaceAll('-', '');
  await admin.query('CREATE SCHEMA ' + schema);
  const pool = new pg.Pool(connection);
  t.after(async () => {
    await pool.end();
    try { await admin.query('DROP SCHEMA ' + schema + ' CASCADE'); }
    finally { await admin.end(); }
  });
  async function transaction(work) {
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      await db.query('SET LOCAL search_path TO ' + schema);
      const value = await work(db);
      await db.query('COMMIT');
      return value;
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    } finally { db.release(); }
  }
  const room = randomUUID(), stranger = randomUUID();
  const { yannick, jef } = await transaction(async db => {
    await db.query(await readFile(new URL('./schema.sql',import.meta.url),'utf8'));
    const users = await localTestPlayers(db);
    await db.query(`INSERT INTO web_rooms(id,invite_code,host,guest,host_deck,label,seed,revision,status,pending_request)
      VALUES($1,'unused',$2,$3,'test','test',1,1,'playing',$4)`, [room, users.yannick, users.jef,
      {kind:'manual',requester:'player',id:randomUUID()}]);
    const seat = name => ({ stage:'decision', revision:1, turn:3, history:[], choices:[{id:'pass'}],
      players:{[name]:{hand:[name + '-private']}}, librarySearch:{title:name + '-choice'} });
    await db.query('INSERT INTO web_positions(room_id,revision,player,opponent) VALUES($1,1,$2,$3)',
      [room,seat('player'),seat('opponent')]);
    return users;
  });
  const body = {revision:1, controlVersion:0, concede:true};
  const move = (who, command = body) => transaction(db => applyMove(db,room,who,command));
  await assert.rejects(move(stranger),{status:404});
  await assert.rejects(move(jef,{...body,actionId:'pass'}),{status:400});
  await assert.rejects(move(jef,{...body,controlVersion:1}),{status:409});
  const attempts = await Promise.allSettled([move(yannick),move(jef)]);
  assert.equal(attempts.filter(result => result.status === 'fulfilled').length,1);
  assert.equal(attempts.find(result => result.status === 'rejected').reason.status,409);
  const loser = attempts[0].status === 'fulfilled' ? 'player' : 'opponent';
  const expected = {winner:loser === 'player' ? 'opponent' : 'player',reason:'concession'};
  // A retry from the conceding browser can recover the same committed result.
  const retry = await move(loser === 'player' ? yannick : jef);
  assert.deepEqual(retry.outcome,expected);
  for (const [seat,id,hidden] of [['player',yannick,'opponent-private'],['opponent',jef,'player-private']]) {
    const final = await transaction(db => readSeatPosition(db,room,id));
    assert.equal(final.revision,2);
    assert.equal(final.status,'finished');
    assert.equal(final.pendingRequest,null);
    assert.equal(final.state.stage,'finished');
    assert.equal(final.state.revision,2);
    assert.deepEqual(final.state.choices,[]);
    assert.equal(final.state.librarySearch,undefined);
    assert.deepEqual(final.outcome,expected);
    assert.deepEqual(final.seatNames,{player:'Yannick',opponent:'Jef'});
    assert.ok(final.state.players[seat].hand.includes(seat + '-private'));
    assert.ok(!JSON.stringify(final).includes(hidden));
  }
  await assert.rejects(move(jef,{revision:2,actionId:'pass',controlVersion:1}),{status:409});
  const positions = await transaction(db => db.query('SELECT COUNT(*)::int AS n FROM web_positions WHERE room_id=$1',[room]));
  assert.equal(positions.rows[0].n,2);
});
