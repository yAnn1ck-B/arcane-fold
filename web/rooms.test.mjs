import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import { readSeatPosition, recordSeatReport, savePosition } from "./rooms.mjs";
import { localTestPlayers } from "./fixtures/players.mjs";

test("only members read their seat and reports retain its authoritative historical revision", {
  skip: !process.env.DATABASE_URL && !process.env.PGDATABASE,
}, async () => {
  const client = new pg.Client(process.env.DATABASE_URL ? {connectionString:process.env.DATABASE_URL} : {});
  await client.connect();
  try {
    await client.query("BEGIN");
    const schema = "test_rooms_" + randomUUID().replaceAll("-","");
    await client.query("CREATE SCHEMA " + schema);
    await client.query("SET LOCAL search_path TO " + schema);
    await client.query(await readFile(new URL("./schema.sql",import.meta.url),"utf8"));
    const { yannick: host, jef: guest } = await localTestPlayers(client);
    const stranger = randomUUID(), room = randomUUID();
    await client.query("INSERT INTO web_rooms(id,invite_code,host,guest,host_deck,label,seed,revision,status) VALUES($1,'secret',$2,$3,'private deck','Table',3,2,'playing')",[room,host,guest]);
    for (const revision of [1,2]) {
      const seat = name => ({revision, privateHand:name + " at " + revision, choices:[{label:name + " choice"}], history:[{turn:revision,text:"Turn " + revision}]});
      await client.query("INSERT INTO web_positions(room_id,revision,player,opponent) VALUES($1,$2,$3,$4)",[room,revision,seat("host"),seat("guest")]);
    }
    const view = await readSeatPosition(client,room,guest);
    assert.equal(view.state.privateHand,"guest at 2");
    assert.ok(!JSON.stringify(view).includes("secret"));
    assert.ok(!JSON.stringify(view).includes("host"));
    await assert.rejects(readSeatPosition(client,room,stranger),{status:404});
    const note = {revision:1,details:"Let me choose a target",report:{
      id:randomUUID(),appVersion:"0.4.0", capturedAt:new Date().toISOString(),viewer:"player",
      history:[], board:{privateHand:"fabricated"}, visibleControls:[{label:"Pass"}],
    }};
    await assert.rejects(recordSeatReport(client,room,stranger,note),{status:404});
    await assert.rejects(recordSeatReport(client,room,guest,{...note,details:" \n "}),{status:400});
    await recordSeatReport(client,room,guest,note);
    await recordSeatReport(client,room,guest,note);
    const {rows:[saved]} = await client.query("SELECT snapshot,details FROM web_reports WHERE room_id=$1",[room]);
    assert.equal(saved.snapshot.board.privateHand,"guest at 1");
    assert.equal(saved.snapshot.viewer,"opponent");
    assert.equal(saved.snapshot.history[0].turn,1);
    assert.equal(saved.snapshot.actions[0].label,"guest choice");
    assert.equal(saved.details,note.details);
    await assert.rejects(recordSeatReport(client,room,host,note),{status:409});
    await assert.rejects(recordSeatReport(client,room,guest,{...note,revision:3}),{status:409});

    // Later priority-stop changes can advance the room revision without advancing
    // the engine. Store the pending settings at each revision beside its move cursor.
    const legacy = await client.query("SELECT replay_cursor FROM web_positions WHERE room_id=$1 AND revision=1",[room]);
    assert.equal(legacy.rows[0].replay_cursor,null);
    const current = {id:room,revision:2};
    const journal = {version:1,initial:"opening",moves:[{after:"first",action:"keep"}],pending:{opponent:"upkeep"}};
    const engine = { view:seat => ({stage:"decision",choices:[],history:[],hand:[seat]}), checkpoint:() => structuredClone(journal) };
    await savePosition(client,current,engine);
    journal.pending = {opponent:"full"};
    await savePosition(client,current,engine);
    journal.moves.push({after:"second",action:"pass"}); journal.pending = {};
    await savePosition(client,current,engine);
    const captured = await client.query("SELECT p.revision,p.replay_cursor,r.checkpoint FROM web_positions p JOIN web_rooms r ON r.id=p.room_id WHERE p.room_id=$1 AND p.revision>=3 ORDER BY p.revision",[room]);
    assert.deepEqual(captured.rows.map(row => row.replay_cursor.moveCount),[1,1,2]);
    assert.deepEqual(captured.rows.map(row => row.replay_cursor.pending),[{opponent:"upkeep"},{opponent:"full"},{}]);
    for (const row of captured.rows) {
      const {replay_cursor:cursor,checkpoint} = row;
      assert.equal(cursor.initial,checkpoint.initial);
      assert.equal(cursor.version,checkpoint.version);
      assert.equal(checkpoint.moves.slice(0,cursor.moveCount).at(-1).after,cursor.lastMoveDigest);
    }
    const large = {revision:3,details:"I expected a response window.",report:{...note.report,id:randomUUID(),visibleControls:Array.from({length:300},() => ({label:"x".repeat(700)}))}};
    await recordSeatReport(client,room,guest,large);
    await recordSeatReport(client,room,guest,large);
    const {rows:[{snapshot}]} = await client.query("SELECT snapshot FROM web_reports WHERE id=$1",[large.report.id]);
    assert.equal(snapshot.visibleControls.length,256);
    assert.equal(snapshot.visibleControls[0].label.length,512);
    assert.equal(snapshot.visibleControlsTruncated,true);
    assert.equal(snapshot.replay_cursor,undefined);
    const active = await readSeatPosition(client,room,host);
    assert.ok(!JSON.stringify(active).includes("upkeep"));
    assert.ok(!JSON.stringify(active).includes("checkpoint"));
  } finally {
    await client.query("ROLLBACK").finally(() => client.end());
  }
});
