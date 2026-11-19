import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import { localTestPlayers } from './fixtures/players.mjs';
import { applyMove, changeRequest, closeGames, createRoom, joinRoom, lobby, readSeatPosition, recordSeatReport, resumeRoom, roomHistory } from './rooms.mjs';

test('the lobby exposes joinable seats and keeps decks and occupied games private', {
  skip: !process.env.DATABASE_URL && !process.env.PGDATABASE,
}, async () => {
  const db = new pg.Client(process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : {});
  await db.connect();
  try {
    await db.query('BEGIN');
    const schema = 'test_lobby_' + randomUUID().replaceAll('-', '');
    await db.query('CREATE SCHEMA ' + schema);
    await db.query('SET LOCAL search_path TO ' + schema);
    for (const file of ['schema.sql', 'decks.sql']) {
      await db.query(await readFile(new URL(file, import.meta.url), 'utf8'));
    }
    const { yannick, jef } = await localTestPlayers(db);
    const legacyPlayer = randomUUID();
    await db.query('INSERT INTO web_players(id,session_hash) VALUES($1,$2)', [legacyPlayer, randomUUID()]);
    const waiting = randomUUID(), full = randomUUID(), finished = randomUUID(), own = randomUUID();
    for (const [id, host, guest, status] of [
      [waiting, yannick, null, 'waiting'], [full, yannick, legacyPlayer, 'playing'],
      [finished, legacyPlayer, yannick, 'finished'], [own, jef, legacyPlayer, 'finished'],
    ]) {
      await db.query(`INSERT INTO web_rooms(id,invite_code,host,guest,host_deck,label,seed,status)
        VALUES($1,$2,$3,$4,'private decklist','private deck name',123,$5)`, [id, randomUUID(), host, guest, status]);
    }
    const view = await lobby(jef, db);
    assert.equal(view.openRooms.length, 1);
    const [table] = view.openRooms;
    assert.deepEqual(Object.keys(table).sort(), ['hostName', 'id', 'openedAt']);
    assert.equal(table.id, waiting);
    assert.equal(table.hostName, 'Yannick');
    assert.deepEqual(view.rooms.map(room => room.id), [own]);
    assert.equal(view.rooms[0].current,false);
    assert.equal((await readSeatPosition(db,waiting,yannick)).waitingForName,'Jef');
    await assert.rejects(readSeatPosition(db, waiting, jef), { status: 404 });

    await db.query("UPDATE web_rooms SET guest=$2, status='playing' WHERE id=$1", [waiting, jef]);
    const joined = await lobby(jef, db);
    assert.equal(joined.openRooms.length, 0);
    assert.equal(joined.rooms.find(room => room.id === waiting).seat, 'opponent');
    assert.equal(joined.rooms.find(room => room.id === waiting).current,true);
  } finally {
    await db.query('ROLLBACK').finally(() => db.end());
  }
});

async function lobbyDatabase(t) {
  const connection = process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : {};
  const admin = new pg.Client(connection);
  await admin.connect();
  const schema = 'test_waiting_' + randomUUID().replaceAll('-', '');
  await admin.query('CREATE SCHEMA ' + schema);
  const db = new pg.Pool({...connection, options:'-c search_path=' + schema});
  t.after(async () => {
    await db.end();
    try { await admin.query('DROP SCHEMA ' + schema + ' CASCADE'); } finally { await admin.end(); }
  });
  assert.equal((await db.query('SELECT current_schema() AS name')).rows[0].name,schema);
  const schemaSql = await readFile(new URL('./schema.sql',import.meta.url),'utf8');
  await db.query(schemaSql);
  await db.query(await readFile(new URL('./decks.sql',import.meta.url),'utf8'));
  return {db, schemaSql, ...await localTestPlayers(db)};
}

test('the pair shares a current game and older waiting games and unfinished boards survive migration', {
  skip: !process.env.DATABASE_URL && !process.env.PGDATABASE,
}, async t => {
  const {db, schemaSql,yannick,jef} = await lobbyDatabase(t);
  const [first, second] = await Promise.all([
    createRoom(yannick,'practice-elves',db), createRoom(yannick,'practice-fire',db),
  ]);
  assert.deepEqual(first,second);
  const unchanged = (await db.query('SELECT host_deck,label FROM web_rooms WHERE id=$1',[first.id])).rows[0];
  assert.deepEqual(await createRoom(yannick,'removed-deck-id',db),first);
  assert.deepEqual((await db.query('SELECT host_deck,label FROM web_rooms WHERE id=$1',[first.id])).rows[0],unchanged);
  assert.equal((await lobby(jef,db)).openRooms.length,1);

  // Simulate two waiting rows saved by an older version in this isolated schema.
  await db.query('DROP INDEX web_one_visible_open_game_per_host');
  const older = randomUUID();
  await db.query(`INSERT INTO web_rooms(id,invite_code,host,label,host_deck,seed,updated_at)
    VALUES ($1,$2,$3,'Old game','Old deck',1,now() - interval '1 day')`,[older,older,yannick]);
  await db.query(schemaSql);
  await db.query(schemaSql);
  assert.deepEqual((await lobby(jef,db)).openRooms.map(room => room.id),[first.id]);
  assert.deepEqual((await lobby(yannick,db)).rooms.map(room => room.id),[first.id]);
  assert.deepEqual((await db.query('SELECT superseded_by,host_deck FROM web_rooms WHERE id=$1',[older])).rows,
    [{superseded_by:first.id,host_deck:'Old deck'}]);
  await assert.rejects(readSeatPosition(db,older,yannick),{status:410});
  await assert.rejects(readSeatPosition(db,older,jef),{status:404});
  await db.query("UPDATE web_rooms SET guest=$2,status='playing' WHERE id=$1",[first.id,jef]);
  assert.deepEqual(await createRoom(yannick,'practice-elves',db),first);
  assert.deepEqual(await createRoom(jef,'practice-fire',db),first);

  // The older server allowed reciprocal waiting games and multiple active
  // games for the same pair, including games with the seats reversed.
  await db.query('DROP INDEX web_one_visible_playing_game_per_pair');
  const reciprocal = randomUUID(), saved = randomUUID(), checkpoint = { privateHistory:'preserved' };
  await db.query(`INSERT INTO web_rooms(id,invite_code,host,label,host_deck,seed)
    VALUES($1,$2,$3,'Reciprocal waiting','Untouched deck',3)`, [reciprocal,reciprocal,jef]);
  await db.query(`INSERT INTO web_rooms(id,invite_code,host,guest,label,host_deck,guest_deck,seed,status,revision,checkpoint,updated_at)
    VALUES($1,$2,$3,$4,'Other game','Guest deck','Host deck',2,'playing',9,$5,now()-interval '1 day')`,
    [saved,saved,jef,yannick,checkpoint]);
  await db.query(schemaSql);
  const after = await lobby(jef,db);
  assert.deepEqual(after.openRooms,[]);
  assert.deepEqual(after.rooms.filter(room => room.current).map(room => room.id),[first.id]);
  assert.deepEqual(after.rooms.filter(room => room.paused).map(room => room.id),[saved]);
  await assert.rejects(readSeatPosition(db,saved,yannick),{status:409});
  await assert.rejects(applyMove(db,saved,jef,{revision:9,concede:true}),{status:409});
  await assert.rejects(joinRoom(yannick,reciprocal,'practice-fire',db),{status:409});
  await assert.rejects(resumeRoom(jef,saved,db),{status:409});
  await db.query("UPDATE web_rooms SET status='finished' WHERE id=$1",[first.id]);
  await db.query(schemaSql);
  assert.equal((await lobby(jef,db)).rooms.find(room => room.id===saved).paused,true);
  const next = await createRoom(yannick,'practice-elves',db);
  assert.notEqual(next.id,first.id);
  assert.deepEqual((await lobby(jef,db)).openRooms.map(room => room.id),[next.id]);
  await assert.rejects(resumeRoom(jef,saved,db),{status:409});
  await db.query("UPDATE web_rooms SET guest=$2,status='finished' WHERE id=$1",[next.id,jef]);
  await assert.rejects(resumeRoom(randomUUID(),saved,db),{status:404});
  assert.deepEqual(await Promise.all([resumeRoom(yannick,saved,db),resumeRoom(jef,saved,db)]),[{id:saved},{id:saved}]);
  const stored = await db.query('SELECT paused_at,checkpoint,revision,host_deck,guest_deck FROM web_rooms WHERE id=$1',[saved]);
  assert.deepEqual(stored.rows,[{paused_at:null,checkpoint,revision:9,host_deck:'Guest deck',guest_deck:'Host deck'}]);
  assert.equal((await lobby(yannick,db)).rooms.find(room => room.current).id,saved);
});

test('archived games retain their records, reject stale requests and free both seats for a fresh game', {
  skip: !process.env.DATABASE_URL && !process.env.PGDATABASE,
}, async t => {
  const {db,schemaSql,yannick,jef} = await lobbyDatabase(t);
  const waiting = randomUUID(), playing = randomUUID(), earlier = randomUUID(), finished = randomUUID();
  for (const [id,guest,status,paused] of [
    [waiting,null,'waiting',false], [playing,jef,'playing',false],
    [earlier,jef,'playing',true], [finished,jef,'finished',false],
  ]) {
    await db.query(`INSERT INTO web_rooms(id,invite_code,host,guest,host_deck,label,seed,status,paused_at)
      VALUES ($1,$2,$3,$4,'Original deck','Original game',1,$5,CASE WHEN $6 THEN now() END)`,
      [id,id,yannick,guest,status,paused]);
  }
  await db.query(`INSERT INTO web_positions(room_id,revision,player,opponent)
    VALUES ($1,0,'{"history":["Existing history"]}','{}')`,[playing]);
  const reportId = randomUUID();
  await db.query(`INSERT INTO web_reports(id,reporter,room_id,revision,seat,details,snapshot)
    VALUES ($1,$2,$3,0,'player','Original report','{}')`,[reportId,yannick,playing]);
  const snapshot = () => db.query(`SELECT to_jsonb(r)-'archived_at' AS original
    FROM web_rooms r WHERE id=ANY($1::uuid[]) ORDER BY id`,[[waiting,playing,earlier,finished]]);
  const before = await snapshot();
  // An existing installation has the old partial indexes. They must release
  // the archived host and player pair when a new game uses the same seats.
  await db.query(`CREATE UNIQUE INDEX web_one_open_game_per_host ON web_rooms(host)
      WHERE status='waiting' AND guest IS NULL AND superseded_by IS NULL;
    CREATE UNIQUE INDEX web_one_playing_game_per_pair ON web_rooms (least(host,guest),greatest(host,guest))
      WHERE status='playing' AND guest IS NOT NULL AND paused_at IS NULL`);
  await db.query('UPDATE web_rooms SET archived_at=now() WHERE id=ANY($1::uuid[])',[[waiting,playing,earlier,finished]]);
  await db.query(schemaSql);
  for (const player of [yannick,jef]) {
    const view = await lobby(player,db);
    assert.deepEqual(view.rooms,[]);
    assert.deepEqual(view.openRooms,[]);
    assert.ok(view.decks.length);
    for (const id of [waiting,playing,earlier,finished]) {
      await assert.rejects(readSeatPosition(db,id,player),{status:404});
      await assert.rejects(roomHistory(id,player,db),{status:404});
      await assert.rejects(resumeRoom(player,id,db),{status:404});
    }
  }
  await assert.rejects(joinRoom(jef,waiting,'practice-fire',db),{status:404});
  await assert.rejects(applyMove(db,playing,yannick,{revision:0,concede:true}),{status:404});
  await assert.rejects(changeRequest(db,playing,jef,{revision:0,kind:'manual'}),{status:404});
  await assert.rejects(recordSeatReport(db,playing,yannick,{}),{status:404});
  const fresh = await createRoom(yannick,'practice-elves',db);
  assert.deepEqual((await lobby(jef,db)).openRooms.map(room => room.id),[fresh.id]);
  await db.query("UPDATE web_rooms SET status='playing',guest=$2 WHERE id=$1",[fresh.id,jef]);
  await db.query(schemaSql);
  assert.deepEqual((await lobby(jef,db)).rooms.map(room => room.id),[fresh.id]);
  assert.deepEqual((await snapshot()).rows,before.rows);
  assert.deepEqual((await db.query('SELECT player FROM web_positions WHERE room_id=$1',[playing])).rows,
    [{player:{history:['Existing history']}}]);
  assert.deepEqual((await db.query('SELECT details FROM web_reports WHERE id=$1',[reportId])).rows,[{details:'Original report'}]);
});

test('simultaneous reciprocal creates, joins and create retries converge on the same game', {
  skip: !process.env.DATABASE_URL && !process.env.PGDATABASE,
}, async t => {
  const {db,yannick,jef} = await lobbyDatabase(t);
  const attempts = await Promise.allSettled([
    createRoom(yannick,'practice-elves',db),createRoom(jef,'practice-fire',db),
  ]);
  const success = attempts.find(item => item.status === 'fulfilled');
  assert.equal(attempts.filter(item => item.status === 'fulfilled').length,1);
  assert.equal(attempts.find(item => item.status === 'rejected').reason.status,409);
  const host = attempts[0].status==='fulfilled' ? yannick : jef;
  const guest = host===yannick ? jef : yannick;
  assert.deepEqual((await lobby(guest,db)).openRooms.map(room => room.id),[success.value.id]);
  if (process.env.FORGE_INSTALL) {
    t.after(closeGames);
    const results = await Promise.allSettled([
      joinRoom(guest,success.value.id,'practice-elves',db),joinRoom(guest,success.value.id,'practice-fire',db),
      createRoom(guest,'practice-fire',db),
    ]);
    assert.deepEqual(results.slice(0,2),[0,1].map(() => ({status:'fulfilled',value:success.value})));
    if (results[2].status==='fulfilled') assert.deepEqual(results[2].value,success.value);
    else assert.equal(results[2].reason.status,409);
    assert.equal((await db.query('SELECT count(*)::int AS games FROM web_rooms')).rows[0].games,1);
    for (const player of [host,guest]) {
      assert.deepEqual(await createRoom(player,'practice-fire',db),success.value);
      const session = await lobby(player,db);
      assert.equal(session.openRooms.length,0);
      assert.deepEqual(session.rooms.filter(room => room.current).map(room => room.id),[success.value.id]);
    }
  }
});
