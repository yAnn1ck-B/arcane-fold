import assert from 'node:assert/strict';
import test from 'node:test';
import { createGame } from './forge.mjs';
import { rewindForge } from './room-history.mjs';

const installed = {skip:!process.env.FORGE_INSTALL,timeout:180_000};
const seed = '814290991531';
const deck = (...lines) => ['[Main]',...lines,''].join('\n');
const onBoard = (game, name, viewer='player') => Object.values(game.view(viewer).players)
  .flatMap(board => board.battlefield).find(card => card.name === name);

// Pass both players' optional windows unless the scenario calls for a specific
// play. Keep their hands, make land drops and decline attacks.
async function advanceUntil(game, reached, choose = () => null) {
  for (let i=0; i<140; i++) {
    const state = game.view(game.view('player').actor);
    assert.notEqual(state.stage,'finished','Game ended before the expected position');
    if (reached(state)) return state;
    const option = choose(state) ?? state.choices.find(c => c.label === 'Keep hand')
      ?? state.choices.find(c => c.label.startsWith('Play '))
      ?? state.choices.find(c => c.kind === 'pass' || c.label === 'No attacks')
      ?? state.choices.find(c => c.label.startsWith('Discard '));
    assert.ok(option,state.prompt + ': ' + state.choices.map(c => c.label).join(', '));
    await game.act(state.actor, option.id);
  }
  assert.fail('Did not reach the requested board position');
}

test('a pre-status creature journal restores sickness for both seats and rewinds its older seat views', installed, async t => {
  const decks = [deck('12 Forest','12 Llanowar Elves'),deck('16 Mountain')];
  // Recorded from Forge 2.0.13 before the bridge exposed battlefield conditions.
  const checkpoint = {version:1,initial:'a6062cf0b25deec0bb6da77b0042e99fcaab1e590042464cd7eced80af7ed269',
    moves:[
      {seat:'player',action:'p1_0',stops:{player:'v2:endStep:',opponent:'v2::'},after:'d43e45b99453a36f48d4b7608f9ddc6c4348281e0edf3a14c7f80c92c4b5d605'},
      {seat:'opponent',action:'p2_0',stops:{},after:'571a67365cf181db8f6e33dbfa9f64ece1c71ccf9cc3e64300b8c9a4acc32afb'},
      {seat:'player',action:'p3_0',stops:{},after:'0acdecdd5bcda9a9e5b1d1f1031c078290340104952f453aeba800845b41b72e'},
      {seat:'player',action:'p4_0',stops:{},after:'ba51e90c3161c770946cd9f8cb559717816b3c0bee90b4fd7a09abc7a41af49e'},
    ],pending:{}};
  const game = await createGame({decks,seed,checkpoint});
  t.after(() => game.close());
  assert.deepEqual(game.checkpoint(),checkpoint);
  const position = {revision:5};
  for (const seat of ['player','opponent']) {
    const view = game.view(seat);
    const elf = view.players.player.battlefield.find(card => card.name === 'Llanowar Elves');
    assert.equal(elf.summoningSick,true);
    assert.equal(elf.tapped,false);
    assert.equal(typeof elf.groupingState,'number');
    assert.equal(onBoard(game,'Forest',seat).summoningSick,undefined);
    assert.ok(view.players.player.hand.every(card => !card.summoningSick));
    // These are the two seat projections saved before the display upgrade.
    delete view.battlefieldStatusVersion;
    delete elf.summoningSick;
    for (const board of Object.values(view.players)) {
      for (const card of board.battlefield) {
        if (seat === 'player') delete card.groupingState;
        else card.groupingState = 999;
      }
    }
    position[seat] = view;
  }
  const room = {host_deck:decks[0],guest_deck:decks[1],seed,checkpoint};
  const restored = await rewindForge(room,position);
  t.after(() => restored.close());
  assert.equal(onBoard(restored,'Llanowar Elves').summoningSick,true);
  await advanceUntil(restored,s => s.active === 'player' && s.turn >= 3);
  assert.equal(onBoard(restored,'Llanowar Elves').summoningSick,undefined);
});

test('Hexproof from Snakeskin Veil expires, counters persist, and both seats can see a phased permanent until it phases in', installed, async t => {
  const decks = [deck('8 Forest','8 Llanowar Elves','8 Snakeskin Veil'),deck('12 Island','12 Slip Out the Back')];
  const game = await createGame({decks,seed,priorities:{player:{own:['endStep'],opponent:['endStep']}}});
  t.after(() => game.close());
  function chooseSpell(state, spell) {
    return state.choices.find(c => c.kind === 'target' && c.label.includes('Llanowar Elves'))
      ?? (state.stack.length === 0 && state.choices.find(c => c.label === 'Cast ' + spell) || null);
  }
  await advanceUntil(game,() => !!onBoard(game,'Llanowar Elves'),state => chooseSpell(state,'Llanowar Elves'));
  await advanceUntil(game,() => !!onBoard(game,'Llanowar Elves').grantedKeywords,state => chooseSpell(state,'Snakeskin Veil'));
  for (const viewer of ['player','opponent']) {
    const elf = onBoard(game,'Llanowar Elves',viewer);
    assert.deepEqual(elf.grantedKeywords,['Hexproof']);
    assert.equal(elf.counters['+1/+1'],1);
  }
  await advanceUntil(game,() => !onBoard(game,'Llanowar Elves').grantedKeywords);
  await advanceUntil(game,() => !!onBoard(game,'Llanowar Elves').phasedOut,state => chooseSpell(state,'Slip Out the Back'));
  for (const viewer of ['player','opponent']) {
    const elf = onBoard(game,'Llanowar Elves',viewer);
    assert.equal(elf.phasedOut,true);
    assert.equal(elf.counters['+1/+1'],2);
    assert.deepEqual(game.view(viewer).players[viewer === 'player' ? 'opponent' : 'player'].hand,[]);
  }
  const checkpoint = game.checkpoint();
  assert.equal(checkpoint.moves.at(-1).battlefieldStatusVersion,1);
  const oldPosition = {replay_cursor:{version:checkpoint.version,initial:checkpoint.initial,moveCount:checkpoint.moves.length,
    lastMoveDigest:checkpoint.moves.at(-1).after,pending:checkpoint.pending}};
  for (const viewer of ['player','opponent']) {
    const old = game.view(viewer);
    delete old.battlefieldStatusVersion;
    for (const board of Object.values(old.players)) {
      board.battlefield = board.battlefield.filter(card => !card.phasedOut);
      for (const card of board.battlefield) delete card.summoningSick;
    }
    oldPosition[viewer] = old;
  }
  const replay = await rewindForge({host_deck:decks[0],guest_deck:decks[1],seed,checkpoint},oldPosition);
  t.after(() => replay.close());
  assert.deepEqual(replay.view('player'),game.view('player'));
  await advanceUntil(game,() => !onBoard(game,'Llanowar Elves').phasedOut);
  assert.equal(onBoard(game,'Llanowar Elves').counters['+1/+1'],2);
});

test('haste, an explicit Pacifism restriction, and a tapped permanent have distinct public states', installed, async t => {
  const decks = [deck('12 Mountain','12 Fanatical Firebrand'),deck('12 Plains','12 Pacifism')];
  const game = await createGame({decks,seed});
  t.after(() => game.close());
  await advanceUntil(game,() => !!onBoard(game,'Fanatical Firebrand'),state => state.choices.find(c => c.label === 'Cast Fanatical Firebrand'));
  const first = onBoard(game,'Fanatical Firebrand');
  assert.equal(first.tapped,false);
  assert.equal(first.summoningSick,undefined);
  assert.equal(first.grantedKeywords,undefined); // Printed haste is intrinsic.
  assert.equal(first.cantAttack,undefined);
  await advanceUntil(game,() => !!onBoard(game,'Pacifism'),state =>
    state.choices.find(c => c.label === 'Cast Pacifism' || c.kind === 'target' && c.label.includes('Fanatical Firebrand')));
  for (const viewer of ['player','opponent']) {
    const enchanted = onBoard(game,'Fanatical Firebrand',viewer);
    assert.equal(enchanted.cantAttack,true);
    assert.equal(enchanted.cantBlock,true);
    assert.equal(enchanted.summoningSick,undefined);
    assert.equal(onBoard(game,'Pacifism',viewer).attachedTo,enchanted.id);
  }
});

test('a land animated the turn it enters has summoning sickness only while it is a creature', installed, async t => {
  const game = await createGame({decks:[deck("16 Mishra's Factory"),deck('16 Forest')],seed,
    priorities:{player:{own:['endStep'],opponent:['upkeep']}}});
  t.after(() => game.close());
  const factories = () => game.view('player').players.player.battlefield;
  await advanceUntil(game,() => factories().length === 2);
  assert.equal(factories()[0].groupingState,factories()[1].groupingState);
  const newest = factories()[1].id;
  const factory = () => factories().find(card => card.id === newest);
  assert.equal(factory().summoningSick,undefined);
  await advanceUntil(game,() => typeof factory().power === 'number',
    state => state.choices.find(c => c.cardId === newest && c.label.includes('Assembly-Worker artifact creature')));
  assert.equal(factories()[0].tapped,true); // The older land paid for the animation.
  assert.equal(factory().tapped,false);
  assert.equal(factory().summoningSick,true);
  await advanceUntil(game,() => typeof factory().power !== 'number');
  assert.equal(factory().tapped,false);
  assert.equal(factory().summoningSick,undefined);
});

test('changing control of a ready creature imposes sickness until its new controller’s next turn', installed, async t => {
  const game = await createGame({decks:[deck('12 Forest','12 Llanowar Elves'),deck('18 Island','6 Mind Control')],seed,
    priorities:{opponent:{own:['endStep'],opponent:['endStep']}}});
  t.after(() => game.close());
  await advanceUntil(game,() => !!onBoard(game,'Llanowar Elves'),
    state => state.choices.find(c => c.label === 'Cast Llanowar Elves'));
  await advanceUntil(game,() => !onBoard(game,'Llanowar Elves').summoningSick);
  await advanceUntil(game,() => !!onBoard(game,'Mind Control'),state =>
    state.choices.find(c => c.label === 'Cast Mind Control' || c.kind === 'target' && c.label.includes('Llanowar Elves')));
  const enchanted = game.view('opponent').players.opponent.battlefield.find(card => card.name === 'Llanowar Elves');
  assert.equal(enchanted.summoningSick,true);
  assert.equal(enchanted.tapped,false);
  await advanceUntil(game,() => !onBoard(game,'Llanowar Elves').summoningSick);
  assert.equal(game.view('opponent').players.opponent.battlefield.find(card => card.name === 'Llanowar Elves').id,enchanted.id);
});

test('Grappling Kraken’s stun counter prevents one untap independently of summoning sickness', installed, async t => {
  const game = await createGame({decks:[deck('16 Forest','8 Llanowar Elves'),deck('18 Island','6 Grappling Kraken')],seed,
    priorities:{player:{own:['upkeep'],opponent:['endStep']}}});
  t.after(() => game.close());
  const elf = () => onBoard(game,'Llanowar Elves');
  const stunCount = () => Object.entries(elf().counters ?? {}).find(([name]) => name.toLowerCase() === 'stun')?.[1] ?? 0;
  await advanceUntil(game,() => !!elf(),state => state.choices.find(c => c.label === 'Cast Llanowar Elves'));
  await advanceUntil(game,() => !!onBoard(game,'Grappling Kraken'),state => state.choices.find(c => c.label === 'Cast Grappling Kraken'));
  await advanceUntil(game,() => stunCount() === 1,state => state.choices.find(c => c.kind === 'target' && c.label.includes('Llanowar Elves')));
  assert.equal(elf().tapped,true);
  assert.equal(elf().summoningSick,undefined);
  await advanceUntil(game,() => stunCount() === 0);
  assert.equal(elf().tapped,true);
});

test('phasing a face-down permanent exposes only its public conditions', installed, async t => {
  const game = await createGame({decks:[deck('12 Plains','12 Soul Summons'),deck('12 Island','12 Slip Out the Back')],seed,
    priorities:{player:{own:['endStep'],opponent:['endStep']}}});
  t.after(() => game.close());
  const manifest = () => game.view('opponent').players.player.battlefield.find(card => card.faceDown);
  await advanceUntil(game,() => !!manifest(),state => state.choices.find(c => c.label === 'Cast Soul Summons'));
  assert.equal(manifest().summoningSick,true);
  await advanceUntil(game,() => manifest().phasedOut,state =>
    state.choices.find(c => c.label === 'Cast Slip Out the Back' || c.kind === 'target' && c.label.includes('Face-down card')));
  assert.equal(manifest().name,'Face-down card');
  assert.equal(manifest().power,3);
  assert.equal(manifest().counters['+1/+1'],1);
  for (const privateField of ['oracleText','setCode','collectorNumber','typeLine','manaCost','grantedKeywords','groupingState']) {
    assert.equal(manifest()[privateField],undefined);
  }
});
