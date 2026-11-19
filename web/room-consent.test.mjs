import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import { createGame } from './forge.mjs';
import { applyMove, changeRequest, readSeatPosition, recordSeatReport, savePosition } from './rooms.mjs';
import { historySteps } from './room-history.mjs';

test('both seats consent to rewinding a finished Forge game, handoff and manual rewind', {
  skip: !process.env.FORGE_INSTALL || (!process.env.DATABASE_URL && !process.env.PGDATABASE), timeout: 240_000,
}, async t => {
  const db = new pg.Client(process.env.DATABASE_URL ? {connectionString:process.env.DATABASE_URL} : {});
  await db.connect();
  t.after(async () => { await db.query('ROLLBACK'); await db.end(); });
  await db.query('BEGIN');
  const schema = 'consent_test_' + randomUUID().replaceAll('-','');
  await db.query('CREATE SCHEMA ' + schema);
  await db.query('SET LOCAL search_path TO ' + schema);
  await db.query(await readFile(new URL('./schema.sql',import.meta.url),'utf8'));
  const host = randomUUID(), guest = randomUUID(), outsider = randomUUID(), id = randomUUID();
  for (const player of [host,guest,outsider]) await db.query('INSERT INTO web_players(id,session_hash) VALUES($1,$2)',[player,player]);
  const decks = ['[Main]\n7 Forest\n','[Main]\n7 Mountain\n'];
  const seed = '8946949592';
  await db.query("INSERT INTO web_rooms(id,invite_code,host,guest,host_deck,guest_deck,label,seed) VALUES ($1,'invite',$2,$3,$4,$5,'test',$6)",
    [id,host,guest,...decks,seed]);
  const room = {id,revision:0,mode:'forge'};
  const game = await createGame({decks,seed});
  t.after(() => game.close());
  await savePosition(db,room,game);
  // The earliest version of the web app only retained the two seat projections.
  await db.query('UPDATE web_positions SET replay_cursor=NULL WHERE room_id=$1 AND revision=1',[id]);
  const first = await readSeatPosition(db,id,host);
  let restored;
  const track = (_,engine) => { restored = engine; t.after(() => engine.close()); };
  const request = async (player,body) => {
    const { controlVersion } = await readSeatPosition(db,id,host);
    return changeRequest(db,id,player,{controlVersion,...body},track);
  };
  const proposal = await request(host,{revision:room.revision,kind:'manual'});
  const confirmation = {revision:room.revision,requestId:proposal.pendingRequest.id};
  await assert.rejects(request(host,{...confirmation,decision:'accept'}),{status:403});
  await assert.rejects(request(outsider,{...confirmation,decision:'accept'}),{status:404});
  await assert.rejects(request(guest,{revision:1,kind:'manual'}),{status:409});
  await assert.rejects(applyMove(db,id,host,{revision:1,actionId:'bogus'},track),{status:409});
  const declined = await request(guest,{...confirmation,decision:'decline'});
  assert.equal(declined.mode,'forge');
  assert.equal(declined.revision,1);
  assert.equal(declined.lastResolution.decision,'decline');
  await assert.rejects(applyMove(db,id,host,{revision:1,controlVersion:0,actionId:'bogus'},track),{status:409});
  await assert.rejects(request(guest,{...confirmation,decision:'accept'}),{status:409});
  await assert.rejects(request(host,{revision:1,controlVersion:proposal.controlVersion,kind:'manual'}),{status:409});
  const cancellable = await request(guest,{revision:1,kind:'manual'});
  const cancel = {revision:1,requestId:cancellable.pendingRequest.id,decision:'cancel'};
  await assert.rejects(request(host,cancel),{status:403});
  assert.equal((await request(guest,cancel)).lastResolution.decision,'cancel');

  // Empty libraries ensure a real rules-enforced loss on the first required draw.
  while (game.view('player').stage !== 'finished' && room.revision < 30) {
    const actor = game.view('player').actor;
    const {choices} = game.view(actor);
    const action = choices.find(c => c.label === 'Keep hand') ?? choices.find(c => c.kind === 'pass') ?? choices[0];
    await game.act(actor,action.id);
    await savePosition(db,room,game);
  }
  assert.equal(game.view('player').stage,'finished');
  const finalRevision = room.revision;
  const finalHistory = game.view('player').history;
  const archiveReport = {revision:finalRevision,details:'Check this final position',report:{
    id:randomUUID(),appVersion:'test',capturedAt:new Date().toISOString(),
  }};
  await recordSeatReport(db,id,guest,archiveReport);
  const steps = await historySteps(db,room);
  assert.equal(steps[0].revision,1);
  assert.equal(steps[0].label,'Opening hands dealt');
  assert.doesNotMatch(JSON.stringify(steps),/Forest|Mountain/);
  const rewind = await request(guest,{revision:finalRevision,kind:'undo',targetRevision:1});
  assert.equal(rewind.status,'finished');
  const accept = {revision:finalRevision,requestId:rewind.pendingRequest.id,decision:'accept'};
  const returned = await request(host,accept);
  assert.equal(returned.status,'playing');
  assert.equal(returned.revision,finalRevision+1);
  assert.deepEqual({...returned.state,revision:first.state.revision},first.state);
  assert.equal(returned.undoAvailable,false);
  await assert.rejects(request(host,accept),{status:409});
  assert.equal(restored.checkpoint().moves.length,0);
  const archived = (await db.query(`SELECT p.retired_at,j.checkpoint,r.snapshot FROM web_reports r
    JOIN web_positions p USING(room_id,revision) JOIN web_forge_journals j
    ON j.room_id=p.room_id AND j.head_revision=p.retired_at WHERE r.id=$1`,[archiveReport.report.id])).rows[0];
  assert.equal(archived.retired_at,finalRevision);
  assert.equal(archived.checkpoint.moves.length,finalRevision-1);
  assert.deepEqual(archived.snapshot.history,finalHistory);

  // Create a second future, using a modern replay cursor at the branch point.
  const live = {id,revision:returned.revision, mode:'forge'};
  await restored.act('player',restored.view('player').choices.find(c => c.label === 'Keep hand').id);
  await savePosition(db,live,restored);
  await assert.rejects(request(host,{revision:live.revision,kind:'undo',targetRevision:1}),{status:409});
  const second = await request(host,{revision:live.revision,kind:'undo',targetRevision:returned.revision});
  const opening = await request(guest,{revision:live.revision,requestId:second.pendingRequest.id,decision:'accept'});
  const prior = {id,revision:opening.revision,mode:'forge'};
  await restored.stop('opponent','full');
  await savePosition(db,prior,restored);
  const stopRevision = prior.revision;
  await restored.stop('opponent','auto');
  await savePosition(db,prior,restored);
  for (const viewer of ['opponent','player',null]) {
    const labels = await historySteps(db,prior,viewer);
    assert.equal(labels[0].label,'Opening hands dealt');
    const changed = labels.find(step => step.revision === stopRevision);
    assert.equal(changed.label.includes('Your priority setting changed'),viewer === 'opponent');
    assert.doesNotMatch(JSON.stringify(changed),/full|Forest|Mountain/);
  }
  const handoff = await request(host,{revision:prior.revision,kind:'manual'});
  const switched = await request(guest,{revision:prior.revision,requestId:handoff.pendingRequest.id,decision:'accept'});
  assert.equal(switched.mode,'manual');
  assert.equal(switched.state,null);
  assert.equal(switched.undoAvailable,false);
  assert.equal(switched.manualState.view.players[0].zones.hand.length,0);
  assert.equal(switched.manualState.view.players[1].zones.hand.length,7);
  await assert.rejects(request(host,{revision:switched.revision,kind:'undo',targetRevision:opening.revision}),{status:409});
  const keep = await applyMove(db,id,host,{revision:switched.revision,controlVersion:switched.controlVersion,
    manualAction:{type:'keep',seat:0,bottom:[]}},track);
  assert.equal(keep.manualState.view.players[0].kept,true);
  const manualUndo = await request(host,{revision:keep.revision,kind:'undo',targetRevision:switched.revision});
  const manualOpening = await request(guest,{revision:keep.revision,requestId:manualUndo.pendingRequest.id,decision:'accept'});
  assert.equal(manualOpening.revision,keep.revision+1);
  assert.deepEqual(manualOpening.manualState,switched.manualState);
});
