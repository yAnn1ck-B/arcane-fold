import assert from 'node:assert/strict';
import test from 'node:test';
import { createGame } from './forge.mjs';
import { rewindForge } from './room-history.mjs';

test('legal targets and the existing stack refer to exact visible cards for each seat', {
  skip: !process.env.FORGE_INSTALL, timeout: 180_000,
}, async t => {
  const decks = ['[Main]\n14 Forest|FDN\n12 Llanowar Elves|FDN\n10 Giant Growth|FDN\n',
    '[Main]\n15 Mountain|FDN\n15 Burst Lightning|FDN\n'];
  const seed = '814290991531';
  const game = await createGame({ decks, seed });
  t.after(() => game.close());
  const elves = state => state.players.player.battlefield.filter(card => card.name === 'Llanowar Elves');
  const growth = state => state.stack.find(card => card.name === 'Giant Growth');
  let choosing;
  for (let index = 0; index < 100; index++) {
    const { actor } = game.view('player');
    const state = game.view(actor);
    if (state.prompt === 'Choose a target for Burst Lightning' && growth(state)) {
      choosing = state;
      break;
    }
    let choice;
    if (actor === 'player' && !state.stack.length && elves(state).length >= 2 &&
        state.players.opponent.battlefield.some(card => card.name === 'Mountain' && !card.tapped)) {
      choice = state.choices.find(option => option.label === 'Cast Giant Growth' ||
        state.prompt === 'Choose a target for Giant Growth' && option.label === 'Target Llanowar Elves');
    }
    if (actor === 'opponent' && growth(state)) {
      choice = state.choices.find(option => option.label === 'Cast Burst Lightning') ??
        state.choices.find(option => option.label === 'Skip optional cost');
    }
    choice ??= state.choices.find(option => option.label === 'Keep hand' || option.label.startsWith('Play '));
    if (!choice && actor === 'player' && elves(state).length < 2) {
      choice = state.choices.find(option => option.label === 'Cast Llanowar Elves');
    }
    choice ??= state.choices.find(option => option.kind === 'pass' || option.label === 'No attacks') ??
      state.choices.find(option => option.label.startsWith('Discard '));
    assert.ok(choice, state.prompt);
    await game.act(actor, choice.id);
  }
  assert.ok(choosing);
  assert.equal(choosing.actor, 'opponent');
  const candidates = choosing.choices.filter(option => option.kind === 'target');
  assert.deepEqual(candidates.filter(option => option.seat).map(option => option.seat), ['player', 'opponent']);
  assert.deepEqual(new Set(candidates.filter(option => option.cardId).map(option => option.cardId)),
    new Set(elves(choosing).map(card => card.id)));
  const [targeted] = growth(choosing).targetRefs;
  assert.equal(growth(choosing).targetRefs.length, 1);
  assert.ok(candidates.some(option => option.cardId === targeted.cardId));

  const waiting = game.view('player');
  assert.deepEqual(waiting.choices, []);
  assert.equal(waiting.players.opponent.hand.length, 0);
  const [waitingTarget] = growth(waiting).targetRefs;
  assert.ok(elves(waiting).some(card => card.id === waitingTarget.cardId));
  assert.notEqual(waitingTarget.cardId, targeted.cardId, 'Each seat receives its own card handles');

  const checkpoint = game.checkpoint();
  const position = {
    player: structuredClone(waiting), opponent: structuredClone(choosing),
    replay_cursor: { version: checkpoint.version, initial: checkpoint.initial, moveCount: checkpoint.moves.length,
      lastMoveDigest: checkpoint.moves.at(-1).after, pending: checkpoint.pending },
  };
  // Older persisted positions contain the displayed target text without IDs.
  for (const seat of ['player', 'opponent']) delete growth(position[seat]).targetRefs;
  const restored = await rewindForge({ host_deck: decks[0], guest_deck: decks[1], seed, checkpoint }, position);
  t.after(() => restored.close());
  assert.deepEqual(restored.view('opponent'), choosing);
});
