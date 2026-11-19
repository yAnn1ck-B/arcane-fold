import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import { createGame } from './forge.mjs';
import { applyMove, changeRequest, readSeatPosition, recordSeatReport, savePosition } from './rooms.mjs';
import { historySteps } from './room-history.mjs';
import { localTestPlayers } from './fixtures/players.mjs';

test('rewinds require consent in a running Forge or manual game and finished games are final', {
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
  const { yannick: host, jef: guest } = await localTestPlayers(db);
  const outsider = randomUUID();
  const decks = ['[Main]\n7 Forest\n','[Main]\n7 Mountain\n'];
  const seed = '8946949592';
  async function startGame() {
    const id = randomUUID();
    await db.query("INSERT INTO web_rooms(id,invite_code,host,guest,host_deck,guest_deck,label,seed) VALUES ($1,$2,$3,$4,$5,$6,'test',$7)",
      [id,id,host,guest,...decks,seed]);
    const room = {id,revision:0,mode:'forge'};
    const game = await createGame({decks,seed});
    t.after(() => game.close());
    await savePosition(db,room,game);
    return {id, room, game};
  }
  const {id, room, game} = await startGame();
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

  await game.act('player',game.view('player').choices.find(choice => choice.label === 'Keep hand').id);
  await savePosition(db,room,game);
  const branchRevision = room.revision;
  const branchHistory = game.view('player').history;
  const archiveReport = {revision:branchRevision,details:'Check this opening decision',report:{
    id:randomUUID(),appVersion:'test',capturedAt:new Date().toISOString(),
  }};
  await recordSeatReport(db,id,guest,archiveReport);
  const steps = await historySteps(db,room);
  assert.equal(steps[0].revision,1);
  assert.equal(steps[0].label,'Opening hands dealt');
  assert.doesNotMatch(JSON.stringify(steps),/Forest|Mountain/);
  const rewind = await request(guest,{revision:branchRevision,kind:'undo',targetRevision:1});
  assert.equal(rewind.status,'playing');
  const accept = {revision:branchRevision,requestId:rewind.pendingRequest.id,decision:'accept'};
  const returned = await request(host,accept);
  assert.equal(returned.status,'playing');
  assert.equal(returned.outcome,null);
  assert.equal(returned.revision,branchRevision+1);
  assert.deepEqual({...returned.state,revision:first.state.revision},first.state);
  assert.equal(returned.undoAvailable,false);
  await assert.rejects(request(host,accept),{status:409});
  assert.equal(restored.checkpoint().moves.length,0);
  const archived = (await db.query(`SELECT p.retired_at,j.checkpoint,r.snapshot FROM web_reports r
    JOIN web_positions p USING(room_id,revision) JOIN web_forge_journals j
    ON j.room_id=p.room_id AND j.head_revision=p.retired_at WHERE r.id=$1`,[archiveReport.report.id])).rows[0];
  assert.equal(archived.retired_at,branchRevision);
  assert.equal(archived.checkpoint.moves.length,branchRevision-1);
  assert.deepEqual(archived.snapshot.history,branchHistory);

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
  const conceded = await applyMove(db,id,guest,{revision:manualOpening.revision,controlVersion:manualOpening.controlVersion,
    concede:true},track);
  assert.deepEqual(conceded.outcome,{winner:'player',reason:'concession'});
  assert.equal(conceded.manualState.stage,'finished');
  assert.equal(conceded.manualState.requiredOpening,false);
  assert.equal(conceded.manualState.actor,null);
  assert.equal(conceded.manualState.view.players[0].zones.hand.length,0);
  assert.equal(conceded.manualState.history.at(-1).text,'Jef conceded. Yannick wins.');
  assert.equal(conceded.undoAvailable,false);
  await assert.rejects(request(guest,{revision:conceded.revision,kind:'undo',targetRevision:manualOpening.revision}),{status:409});
  assert.equal((await readSeatPosition(db,id,host)).revision,conceded.revision);

  // Empty libraries ensure a real Forge loss on the first required draw.
  const rules = await startGame();
  while (rules.game.view('player').stage !== 'finished' && rules.room.revision < 30) {
    const actor = rules.game.view('player').actor;
    const {choices} = rules.game.view(actor);
    const action = choices.find(c => c.label === 'Keep hand') ?? choices.find(c => c.kind === 'pass') ?? choices[0];
    await rules.game.act(actor,action.id);
    await savePosition(db,rules.room,rules.game);
  }
  const victory = await readSeatPosition(db,rules.id,host);
  assert.deepEqual(victory.outcome,{winner:'player',reason:'rules'});
  assert.deepEqual(victory.seatNames,{player:'Yannick',opponent:'Jef'});
  assert.equal(victory.undoAvailable,false);
  // Earlier versions allowed unfinished undo proposals at a terminal revision
  // and stored Forge's English outcome in place of structured results.
  const stale = {id:randomUUID(),kind:'undo',requester:'player',targetRevision:1};
  await db.query('UPDATE web_positions SET outcome=NULL WHERE room_id=$1 AND revision=$2',[rules.id,victory.revision]);
  await db.query('UPDATE web_rooms SET pending_request=$2 WHERE id=$1',[rules.id,stale]);
  await assert.rejects(changeRequest(db,rules.id,guest,{
    revision:victory.revision,requestId:stale.id,decision:'accept',controlVersion:victory.controlVersion,
  },track),{status:409});
  const terminal = await readSeatPosition(db,rules.id,guest);
  assert.equal(terminal.revision,victory.revision);
  assert.equal(terminal.pendingRequest,null);
  assert.deepEqual(terminal.outcome,victory.outcome);
});
