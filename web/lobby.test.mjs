import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import { localTestPlayers } from './fixtures/players.mjs';
import { applyMove, cancelRoom, changeRequest, closeGames, createRoom, joinRoom, lobby, readSeatPosition, recordSeatReport, resumeRoom, roomHistory } from './rooms.mjs';

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
    const legacyPlayer = randomUUID(), otherPlayer = randomUUID();
    await db.query('INSERT INTO web_players(id,session_hash) VALUES($1,$2),($3,$4)',
      [legacyPlayer,randomUUID(),otherPlayer,randomUUID()]);
    const waiting = randomUUID(), full = randomUUID(), finished = randomUUID(), own = randomUUID();
    for (const [id, host, guest, status] of [
      [waiting, yannick, null, 'waiting'], [full, otherPlayer, legacyPlayer, 'playing'],
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
    const ownView = await readSeatPosition(db,waiting,yannick);
    assert.equal(ownView.status,'waiting');
    assert.equal(Object.hasOwn(ownView,'waitingForName'),false);
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

async function registeredPlayer(db, name) {
  const id = randomUUID();
  await db.query('INSERT INTO web_players(id,session_hash) VALUES($1,$2)', [id,'account:'+id]);
  await db.query("INSERT INTO web_accounts(email,name,password_hash,player_id) VALUES($1,$2,'fixture',$3)",
    [`${id}@arcane-fold.test`,name,id]);
  return id;
}

test('migration keeps disjoint invitations and preserves older overlapping boards and invitations', {
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
  await db.query('DROP TRIGGER web_sync_room_seats ON web_rooms');
  await db.query('CREATE VIEW web_current_game AS SELECT id,host,guest,status FROM web_rooms LIMIT 1');
  const older = randomUUID(), unrelated = randomUUID();
  const camille = await registeredPlayer(db,'Camille');
  await db.query(`INSERT INTO web_rooms(id,invite_code,host,label,host_deck,seed,updated_at)
    VALUES ($1,$2,$3,'Old game','Old deck',1,now() - interval '1 day')`,[older,older,yannick]);
  await db.query(`INSERT INTO web_rooms(id,invite_code,host,label,host_deck,seed)
    VALUES ($1::uuid,$1::uuid::text,$2,'Independent game','Other deck',1)`,[unrelated,camille]);
  await db.query(schemaSql);
  await db.query(schemaSql);
  assert.deepEqual(new Set((await lobby(jef,db)).openRooms.map(room => room.id)),new Set([first.id,unrelated]));
  assert.equal((await db.query('SELECT count(*)::int AS count FROM web_current_game')).rows[0].count,1);
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
  await db.query('DROP TRIGGER web_sync_room_seats ON web_rooms');
  const reciprocal = randomUUID(), saved = randomUUID(), crossover = randomUUID(), checkpoint = { privateHistory:'preserved' };
  await db.query(`INSERT INTO web_rooms(id,invite_code,host,label,host_deck,seed)
    VALUES($1,$2,$3,'Reciprocal waiting','Untouched deck',3)`, [reciprocal,reciprocal,jef]);
  await db.query(`INSERT INTO web_rooms(id,invite_code,host,guest,label,host_deck,guest_deck,seed,status,revision,checkpoint,updated_at)
    VALUES($1,$2,$3,$4,'Other game','Guest deck','Host deck',2,'playing',9,$5,now()-interval '1 day')`,
    [saved,saved,jef,yannick,checkpoint]);
  await db.query(`INSERT INTO web_rooms(id,invite_code,host,guest,label,host_deck,guest_deck,seed,status,revision,checkpoint,updated_at)
    VALUES($1,$2,$3,$4,'Crossed game','Other deck','Guest deck',2,'playing',9,$5,now()-interval '2 days')`,
    [crossover,crossover,camille,jef,checkpoint]);
  await db.query(schemaSql);
  const after = await lobby(jef,db);
  assert.deepEqual(after.openRooms,[]);
  assert.deepEqual(after.rooms.filter(room => room.current).map(room => room.id),[first.id]);
  assert.deepEqual(new Set(after.rooms.filter(room => room.paused).map(room => room.id)),new Set([saved,crossover]));
  assert.equal((await lobby(camille,db)).rooms.find(room => room.current).id,unrelated);
  await assert.rejects(readSeatPosition(db,saved,yannick),{status:409});
  await assert.rejects(applyMove(db,saved,jef,{revision:9,concede:true}),{status:409});
  await assert.rejects(joinRoom(yannick,reciprocal,'practice-fire',db),{status:409});
  await assert.rejects(resumeRoom(jef,saved,db),{status:409});
  await db.query("UPDATE web_rooms SET status='finished' WHERE id=$1",[first.id]);
  await db.query(schemaSql);
  assert.equal((await lobby(jef,db)).rooms.find(room => room.id===saved).paused,true);
  const next = await createRoom(yannick,'practice-elves',db);
  assert.notEqual(next.id,first.id);
  assert.deepEqual(new Set((await lobby(jef,db)).openRooms.map(room => room.id)),new Set([next.id,unrelated]));
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
    await db.query(`INSERT INTO web_rooms(id,invite_code,host,guest,host_deck,label,seed,status,paused_at,archived_at)
      VALUES ($1,$2,$3,$4,'Original deck','Original game',1,$5,CASE WHEN $6 THEN now() END,
        CASE WHEN $5='waiting' THEN now() END)`,
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

test('lobby exposes different open hosts and only the host can cancel an unused invitation', {
  skip: !process.env.DATABASE_URL && !process.env.PGDATABASE,
}, async t => {
  const {db,yannick,jef} = await lobbyDatabase(t);
  const spectator = await registeredPlayer(db, 'Camille');
  const [left,right] = await Promise.all([
    createRoom(yannick,'practice-elves',db),createRoom(jef,'practice-fire',db),
  ]);
  assert.notEqual(left.id,right.id);
  assert.deepEqual(new Map((await lobby(spectator,db)).openRooms.map(room => [room.id,room.hostName])),
    new Map([[left.id,'Yannick'],[right.id,'Jef']]));
  assert.deepEqual((await lobby(jef,db)).openRooms,[]);
  assert.deepEqual(await createRoom(yannick,'practice-fire',db),left);
  await assert.rejects(joinRoom(yannick,right.id,'practice-fire',db),{status:409});
  await assert.rejects(cancelRoom(spectator,left.id,db),{status:404});
  assert.deepEqual(await cancelRoom(yannick,left.id,db),left);
  assert.deepEqual(await cancelRoom(yannick,left.id,db),left);
  await assert.rejects(joinRoom(spectator,left.id,'practice-fire',db),{status:404});
  assert.deepEqual((await lobby(yannick,db)).openRooms.map(room => room.id),[right.id]);
  assert.equal((await db.query('SELECT archived_at IS NOT NULL AS archived FROM web_rooms WHERE id=$1',[left.id])).rows[0].archived,true);
});

test('simultaneous joins reserve one room per player while disjoint pairs play in parallel', {
  skip: !process.env.FORGE_INSTALL || (!process.env.DATABASE_URL && !process.env.PGDATABASE), timeout: 180_000,
}, async t => {
  const {db,yannick,jef} = await lobbyDatabase(t);
  t.after(closeGames);
  const camille = await registeredPlayer(db, 'Camille');
  const ren = await registeredPlayer(db, 'Ren');
  const [left,right] = await Promise.all([
    createRoom(yannick,'practice-elves',db),createRoom(jef,'practice-fire',db),
  ]);
  const attempts = await Promise.allSettled([
    joinRoom(camille,left.id,'practice-fire',db),joinRoom(camille,right.id,'practice-elves',db),
  ]);
  assert.equal(attempts.filter(result => result.status === 'fulfilled').length,1);
  assert.equal(attempts.find(result => result.status === 'rejected').reason.status,409);
  const joined = attempts.find(result => result.status === 'fulfilled').value;
  const waiting = joined.id === left.id ? right : left;
  assert.deepEqual((await lobby(ren,db)).openRooms.map(room => room.id),[waiting.id]);
  assert.deepEqual(await joinRoom(ren,waiting.id,'practice-fire',db),waiting);
  assert.deepEqual(await joinRoom(camille,joined.id,'practice-fire',db),joined);
  assert.deepEqual(await createRoom(ren,'practice-elves',db),waiting);
  const conflicting = randomUUID();
  await assert.rejects(db.query(`INSERT INTO web_rooms(id,invite_code,host,label,host_deck,seed)
    VALUES($1,$2,$3,'Conflict','Other deck',1)`,[conflicting,conflicting,camille]),{code:'23505'});
  const firstView = await readSeatPosition(db,joined.id,camille);
  const secondView = await readSeatPosition(db,waiting.id,ren);
  assert.equal(firstView.status,'playing');
  assert.equal(secondView.status,'playing');
  assert.deepEqual((await lobby(camille,db)).rooms.map(room => room.id),[joined.id]);
  assert.deepEqual((await lobby(ren,db)).rooms.map(room => room.id),[waiting.id]);
  await assert.rejects(readSeatPosition(db,waiting.id,camille),{status:404});
  await assert.rejects(readSeatPosition(db,joined.id,ren),{status:404});
  const {rows} = await db.query('SELECT room_id,count(*)::int AS seats FROM web_live_room_seats GROUP BY room_id');
  assert.deepEqual(new Map(rows.map(({room_id,seats}) => [room_id,seats])),new Map([[left.id,2],[right.id,2]]));
});
