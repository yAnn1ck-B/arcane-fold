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

test('End Turn skips optional attacks and honors the opponent’s stop with both replay behaviors', installed, async t => {
  const config = {decks:['[main]\n12 Mountain\n12 Raging Goblin\n','[main]\n16 Forest\n'],seed:lands.seed};
  // Recorded before the End Turn shortcut could skip optional attacks.
  const checkpoint = {version:1,initial:'93352e9ef813204e264e4c84b5efd7003e274371ce0a9e594d27e56163098972',
    moves:[
      ['player','p1_0','ed9df7a18ec85489cd272ee838a5adf71b3ea1ef2c587603b3ca0829ab014685'],
      ['opponent','p2_0','7430b1fa9693c0182a2f90d6e32e48d96c000edace989beb8abe067500a1c4bf'],
      ['player','p3_0','79295334ed29cc08e65463ce9680d15f3c587dcbe0f812f30038618e4d2a6907'],
      ['player','p4_0','fca5ca3ed3634fa887af1ddc2bd60765b55c05c471750d4aaf750d36caa19a60'],
      ['player','p5_1','e4cc061c22c052e746a4c1fada67cd7d4c38b0e8d4e17b3c8e9362f896c0d936'],
      ['opponent','p6_8_end','199bffa6137b218f330eb55032557c540e8eb54b5a731f50ed50c8655f043ae8'],
      ['opponent','p7_0','1732866ee6498c9a23332cc5fd31c494ae2002ad317d0cf05004047e3d2c650f'],
      ['player','p8_7_end','e7a9f1986f8096be863bab4f77e9d282cea5e4e5ca1836c160db180c4ab5d371'],
    ].map(([seat,action,after],index) => ({seat,action,after,stops:index ? {} : {player:'v2::',opponent:'v2::'},
      battlefieldStatusVersion:1,blockReferencesVersion:1})),pending:{}};
  const oldGame = await createGame({...config,checkpoint});
  t.after(() => oldGame.close());
  assert.deepEqual(oldGame.checkpoint(),checkpoint);
  assert.equal(decision(oldGame).prompt,'Declare attackers');
  assert.ok(decision(oldGame).choices.some(c => c.kind === 'attack'));

  const game = await createGame({...config,checkpoint:{...checkpoint,moves:checkpoint.moves.slice(0,-1)}});
  t.after(() => game.close());
  await game.stop('opponent',{own:[],opponent:['beginCombat']});
  let state = decision(game);
  await game.act('player',state.choices.find(pass).endTurnId,state.revision);
  state = decision(game);
  assert.equal(state.step,'Beginning of combat step');
  assert.equal(state.actor,'opponent');
  assert.equal(state.active,'player');
  state = await take(game,pass);
  assert.equal(state.active,'opponent');
  assert.equal(state.players.opponent.life,20);

  const resumed = await createGame({...config,checkpoint:game.checkpoint()});
  t.after(() => resumed.close());
  assert.deepEqual(decision(resumed),state);
});

test('End Turn still lets Forge enforce a required attack', installed, async t => {
  const game = await createGame({decks:['[main]\n16 Mountain\n12 Bloodrock Cyclops\n','[main]\n18 Forest\n'],seed:lands.seed});
  t.after(() => game.close());
  await opening(game);
  for (const label of ['Play Mountain','Play Forest','Play Mountain','Play Forest',
    'Play Mountain','Cast Bloodrock Cyclops','Play Forest']) {
    await take(game,c => c.label === label);
  }
  const state = decision(game);
  assert.equal(state.active,'player');
  assert.equal(state.phase,'Precombat main phase');
  assert.equal(state.players.opponent.life,20);
  await game.act('player',state.choices.find(pass).endTurnId,state.revision);
  const next = decision(game);
  assert.equal(next.active,'opponent');
  assert.equal(next.players.opponent.life,17);
});

test('Pass Turn skips routine opposing priority, survives replay, and keeps stack responses and stops', installed, async t => {
  const config = {decks:Array(2).fill('[main]\n12 Mountain\n12 Shock\n'), seed:lands.seed,
    priorities:{player:{own:[],opponent:['endStep']}}};
  const game = await createGame(config);
  t.after(() => game.close());
  await opening(game);
  let state = await take(game,c => c.label === 'Play Mountain');
  assert.equal(state.choices.find(pass).passTurnId, undefined);
  await game.act('player',state.choices.find(pass).endTurnId,state.revision);
  state = decision(game);
  assert.equal(state.active,'opponent');
  assert.equal(state.actor,'player');
  assert.equal(state.step,'Upkeep step');
  assert.ok(state.choices.some(c => c.label === 'Cast Shock'));
  const shortcut = state.choices.find(pass).passTurnId;
  assert.ok(shortcut);
  assert.ok(game.view('opponent').choices.every(c => !c.passTurnId));
  await assert.rejects(game.act('opponent',shortcut,state.revision), /unavailable/);
  await game.act('player',shortcut,state.revision);
  state = decision(game);
  assert.equal(state.actor,'opponent');
  assert.equal(state.phase,'Precombat main phase');

  const resumed = await createGame({...config,checkpoint:game.checkpoint()});
  t.after(() => resumed.close());
  assert.deepEqual(decision(resumed),state);
  await take(resumed,c => c.label === 'Play Mountain');
  await take(resumed,c => c.label === 'Cast Shock');
  state = await take(resumed,c => c.kind === 'target' && c.seat === 'player');
  for (let i=0; i<8 && state.actor !== 'player'; i++) state = await take(resumed,pass);
  assert.equal(state.actor,'player');
  assert.ok(state.stack.some(c => c.name === 'Shock'));
  assert.ok(state.choices.some(c => c.label === 'Cast Shock'));
  assert.equal(state.choices.find(pass).passTurnId,undefined);
  state = await take(resumed,pass);
  for (let i=0; i<20 && state.actor === 'opponent'; i++) state = await take(resumed,pass);
  assert.equal(state.actor,'player');
  assert.equal(state.active,'opponent');
  assert.equal(state.step,'End step');
  assert.equal(state.choices.find(pass).passTurnId,undefined);
  state = await take(resumed,pass);
  for (let i=0; i<8 && state.active === 'opponent'; i++) {
    state = await take(resumed,c => pass(c) || c.label.startsWith('Discard '));
  }
  assert.equal(state.active,'player');
  assert.equal(state.actor,'player');
  assert.ok(state.choices.some(c => c.label === 'Cast Shock'));
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
  assert.equal(game.checkpoint().startingSeat,'opponent');
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
  const next = await startForgeGame(db,{...room,host:jef,seed:'814290991530'},yannick,lands.decks[1]);
  t.after(() => next.close());
  assert.equal(next.checkpoint().startingSeat,'player');
  assert.deepEqual(decodePriority(next.view('player').priorityStop),changed);
  assert.deepEqual(decodePriority(next.view('opponent').priorityStop),automatic);
});
