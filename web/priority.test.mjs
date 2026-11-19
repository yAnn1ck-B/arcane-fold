import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import { createGame } from './forge.mjs';
import { localTestPlayers } from './fixtures/players.mjs';
import { decodePriority } from './priority.mjs';
import { applyMove, readSeatPosition, savePosition, startForgeGame } from './rooms.mjs';

const installed = {skip:!process.env.FORGE_INSTALL, timeout:180_000};
const lands = {decks:['[main]\n16 Mountain\n','[main]\n16 Forest\n'],seed:'814290991531'};

function decision(game) {
  return game.view(game.view('player').actor);
}
async function take(game,pick) {
  const state = decision(game);
  const choice = state.choices.find(pick);
  assert.ok(choice, state.prompt + ' · ' + state.choices.map(c => c.label).join(', '));
  await game.act(state.actor,choice.id,state.revision);
  return decision(game);
}
async function opening(game) {
  for (let index=0; index<2; index++) await take(game,c => c.label === 'Keep hand');
}
const pass = c => c.kind === 'pass';

test('recurring stops distinguish own and opposing turns, survive a yield, and open otherwise empty or mana-only windows', installed, async t => {
  const stops = {own:['beginCombat'],opponent:['endStep']};
  const game = await createGame({...lands, priorities:{player:stops}});
  t.after(() => game.close());
  await opening(game);
  assert.equal(decision(game).phase,'Precombat main phase');
  let state = await take(game,c => c.label === 'Play Mountain');
  assert.equal(state.actor,'player');
  assert.equal(state.step,'Beginning of combat step');
  assert.ok(state.choices.some(c => c.manaAbility));
  assert.ok(state.choices.every(c => c.manaAbility || pass(c)));
  await game.stop('opponent',{own:[],opponent:['every']});
  state = await take(game,pass);
  assert.equal(state.actor,'opponent');
  assert.equal(state.active,'player');
  assert.equal(state.step,'Beginning of combat step');
  assert.ok(state.choices.every(pass));
  await game.stop('opponent',{own:[],opponent:[]});
  state = await take(game,pass);
  assert.equal(state.actor,'opponent');
  assert.equal(state.active,'opponent');
  assert.equal(state.phase,'Precombat main phase');
  await game.act('opponent',state.choices.find(pass).endTurnId);
  state = decision(game);
  assert.equal(state.actor,'player');
  assert.equal(state.active,'opponent');
  assert.equal(state.step,'End step');
  assert.deepEqual(decodePriority(state.priorityStop),stops);
  // The same preferences still apply in the next turn cycle.
  state = await take(game,pass);
  assert.equal(state.actor,'opponent');
  assert.match(state.prompt,/Discard to your maximum hand size/);
  state = await take(game,c => c.label.startsWith('Discard Forest'));
  assert.equal(state.active,'player');
  assert.equal(state.phase,'Precombat main phase');
  state = await take(game,c => c.label === 'Play Mountain');
  assert.equal(state.step,'Beginning of combat step');
  assert.equal(state.actor,'player');
});

test('Automatic retains affordable spells and stack responses while skipping mana-only windows', installed, async t => {
  const game = await createGame({decks:['[Main]\n12 Mountain\n12 Shock\n','[Main]\n12 Island\n12 Dispel\n'],seed:'814290991531'});
  t.after(() => game.close());
  await opening(game);
  const first = await take(game,c => c.label === 'Play Mountain');
  assert.ok(first.choices.some(c => c.label === 'Cast Shock'));
  assert.ok(first.choices.some(c => c.manaAbility));
  await game.act('player',first.choices.find(pass).endTurnId);
  // Let the guest develop a blue mana source. Dispel has no legal target yet.
  let state = decision(game);
  for (let i=0; i<20 && !state.choices.some(c => c.label === 'Play Island'); i++) state = await take(game,pass);
  state = await take(game,c => c.label === 'Play Island');
  assert.equal(state.actor,'player');
  assert.equal(state.active,'opponent');
  state = await take(game,c => c.label === 'Cast Shock');
  assert.equal(state.actor,'player');
  state = await take(game,c => c.kind === 'target' && c.seat === 'opponent');
  for (let i=0; i<8 && !state.choices.some(c => c.label === 'Cast Dispel'); i++) state = await take(game,pass);
  assert.equal(state.actor,'opponent');
  assert.ok(state.stack.some(card => card.name === 'Shock'));
  assert.ok(state.choices.some(c => c.label === 'Cast Dispel'));
});

test('Automatic lets a player tap a threatened mana source in response', installed, async t => {
  const game = await createGame({decks:['[Main]\n12 Forest\n12 Llanowar Elves\n','[Main]\n12 Mountain\n12 Shock\n'],seed:lands.seed});
  t.after(() => game.close());
  await opening(game);
  await take(game,c => c.label === 'Play Forest');
  let state = await take(game,c => c.label === 'Cast Llanowar Elves');
  for (let i=0; i<12 && !state.choices.some(c => c.label === 'Play Mountain'); i++) state = await take(game,pass);
  state = await take(game,c => c.label === 'Play Mountain');
  // Wait until the Elves have untapped on their controller's next turn.
  for (let i=0; i<20 && (state.active !== 'player' || state.actor !== 'opponent'); i++) state = await take(game,pass);
  state = await take(game,c => c.label === 'Cast Shock');
  state = await take(game,c => c.kind === 'target' && c.label.includes('Llanowar Elves'));
  for (let i=0; i<8 && state.actor !== 'player'; i++) state = await take(game,pass);
  assert.ok(state.stack.some(card => card.name === 'Shock'));
  assert.ok(state.choices.every(c => c.manaAbility || pass(c)));
  const elves = state.players.player.battlefield.find(card => card.name === 'Llanowar Elves');
  state = await take(game,c => c.manaAbility && c.cardId === elves.id);
  assert.ok(state.players.player.mana > 0);
});

test('a pre-checklist mana-only decision replays exactly and upgrades when the player continues', installed, async t => {
  // Recorded by the original 2.0.13 web controller with the two basic-land decks above.
  const checkpoint = {version:1,initial:'d28534811964183942092cd18990d80ba2ad5a7650e45b8cf81ca6641a15204e',
    moves:[
      {seat:'player',action:'p1_0',stops:{},after:'0c9174e61a0edccfbfd4a682fffad21b72f0277b582a8592793159011bf07da0'},
      {seat:'opponent',action:'p2_0',stops:{},after:'8125a72f1cd1846eefb7fab6f1a71ab9a594d6b03b7bb236958856f6839bcbf0'},
      {seat:'player',action:'p3_0',stops:{},after:'cff906730edbb2c5b9489aac6633718dbc456bf88adc0587eb0afe28485875ac'},
    ],pending:{}};
  const game = await createGame({...lands, checkpoint});
  t.after(() => game.close());
  assert.deepEqual(game.checkpoint(),checkpoint);
  await assert.rejects(game.act('opponent','not a legal choice'),/unavailable/);
  assert.deepEqual(game.checkpoint(),checkpoint);
  assert.equal(decision(game).phase,'Precombat main phase');
  assert.ok(decision(game).choices.every(c => c.manaAbility || pass(c)));
  // The old game would pause for mana again in its second main phase.
  const next = await take(game,pass);
  assert.equal(next.actor,'opponent');
  assert.equal(next.active,'opponent');
  assert.ok(next.choices.some(c => c.label === 'Play Forest'));
  const resumed = await createGame({...lands,checkpoint:game.checkpoint()});
  t.after(() => resumed.close());
  assert.deepEqual(decision(resumed),next);
});

test('priority checklists are private to the signed-in account and follow it into the opposite seat of another game', {
  ...installed, skip:!process.env.FORGE_INSTALL || (!process.env.DATABASE_URL && !process.env.PGDATABASE),
}, async t => {
  const db = new pg.Client(process.env.DATABASE_URL ? {connectionString:process.env.DATABASE_URL} : {});
  await db.connect();
  t.after(async () => { await db.query('ROLLBACK'); await db.end(); });
  await db.query('BEGIN');
  const schema = 'priority_test_' + randomUUID().replaceAll('-','');
  await db.query('CREATE SCHEMA ' + schema);
  await db.query('SET LOCAL search_path TO ' + schema);
  await db.query(await readFile(new URL('./schema.sql',import.meta.url),'utf8'));
  const {yannick,jef} = await localTestPlayers(db);
  const id = randomUUID();
  const room = {id,host:yannick,host_deck:lands.decks[0],seed:lands.seed,mode:'forge',revision:0};
  await db.query("INSERT INTO web_rooms(id,invite_code,host,guest,host_deck,guest_deck,label,seed) VALUES ($1,$2,$3,$4,$5,$6,'Priority',$7)",
    [id,id,yannick,jef,...lands.decks,lands.seed]);
  const game = await startForgeGame(db,room,jef,lands.decks[1]);
  t.after(() => game.close());
  await savePosition(db,room,game);
  const changed = {own:['draw'],opponent:['beginCombat','endStep']};
  const automatic = {own:[],opponent:[]};
  const track = (_,active) => t.after(() => active.close());
  const payload = {stop:changed,controlVersion:0,revision:1};
  await assert.rejects(applyMove(db,id,randomUUID(),payload,track),{status:404});
  await assert.rejects(applyMove(db,id,jef,{...payload,stop:{own:['unknown'],opponent:[]}},track),{status:400});
  const result = await applyMove(db,id,jef,payload,track);
  assert.deepEqual(result.state.priorityStop,changed);
  assert.deepEqual((await readSeatPosition(db,id,yannick)).state.priorityStop,automatic);
  await assert.rejects(applyMove(db,id,jef,{...payload,stop:automatic},track),{status:409});
  const next = await startForgeGame(db,{...room,host:jef},yannick,lands.decks[1]);
  t.after(() => next.close());
  assert.deepEqual(decodePriority(next.view('player').priorityStop),changed);
  assert.deepEqual(decodePriority(next.view('opponent').priorityStop),automatic);
});
