import assert from 'node:assert/strict';
import test from 'node:test';
import { rewindForge } from './room-history.mjs';
import { blockFixtureConfig, startBlockingFixture } from './fixtures/blocks.mjs';

test('duplicate attackers allow exact direct reassignments, removal, double blocks and replay', {
  skip: !process.env.FORGE_INSTALL, timeout: 180_000,
}, async t => {
  const game = await startBlockingFixture();
  t.after(() => game.close());

  const view = () => game.view('opponent');
  const attacks = position => position.players.player.battlefield.filter(card => card.attacking);
  const blocks = position => position.players.opponent.battlefield.filter(card => card.blockingIds?.length);
  const take = choice => {
    assert.ok(choice);
    return game.act('opponent', choice.id, view().revision);
  };
  const choosing = view();
  const attackers = attacks(choosing);
  assert.equal(attackers.length, 2);
  assert.ok(attackers.every(card => card.name === 'Llanowar Elves'));
  const [first] = choosing.choices.filter(choice => choice.block);
  const alternatives = choosing.choices.filter(choice => choice.cardId === first.cardId);
  assert.equal(new Set(alternatives.map(choice => choice.label)).size, 1);
  assert.deepEqual(new Set(alternatives.map(choice => choice.block.attackerId)), new Set(attackers.map(card => card.id)));
  await assert.rejects(game.act('player', first.id, choosing.revision), /unavailable/);
  await take(first);

  const second = view().choices.find(choice => choice.block?.attackerId === first.block.attackerId &&
    !choice.block.remove && choice.cardId !== first.cardId);
  await take(second);
  const double = view();
  const waiting = game.view('player');
  assert.deepEqual(new Set(blocks(double).map(card => card.id)), new Set([first.cardId, second.cardId]));
  assert.ok(blocks(double).every(card => card.blockingIds.length === 1 && card.blockingIds[0] === first.block.attackerId));
  assert.deepEqual(waiting.choices, []);
  assert.equal(blocks(waiting).length, 0);

  const alternate = double.choices.find(choice => choice.cardId === first.cardId &&
    choice.block?.reassign && choice.block.attackerId !== first.block.attackerId);
  await take(alternate);
  assert.deepEqual(blocks(view()).find(card => card.id === first.cardId).blockingIds, [alternate.block.attackerId]);
  assert.deepEqual(blocks(view()).find(card => card.id === second.cardId).blockingIds, [first.block.attackerId]);
  await take(view().choices.find(choice => choice.cardId === first.cardId &&
    choice.block?.attackerId === alternate.block.attackerId && choice.block.remove));
  assert.deepEqual(blocks(view()).map(card => card.id), [second.cardId]);
  await take(view().choices.find(choice => choice.cardId === first.cardId &&
    choice.block?.attackerId === first.block.attackerId && !choice.block.remove));

  const checkpoint = game.checkpoint();
  const position = {
    player: game.view('player'), opponent: view(),
    replay_cursor: {
      version: checkpoint.version, initial: checkpoint.initial, moveCount: checkpoint.moves.length,
      lastMoveDigest: checkpoint.moves.at(-1).after, pending: checkpoint.pending,
    },
  };
  const resumed = await rewindForge({
    host_deck: blockFixtureConfig.decks[0], guest_deck: blockFixtureConfig.decks[1], seed: blockFixtureConfig.seed,
    checkpoint,
  }, position);
  t.after(() => resumed.close());
  assert.deepEqual(resumed.view('opponent'), view());

  // Snapshots written before block references existed remain valid rewind points.
  for (const seat of ['player', 'opponent']) {
    position[seat].choices = position[seat].choices.filter(choice => !choice.block?.reassign);
    for (const choice of position[seat].choices) delete choice.block;
    for (const owner of ['player', 'opponent']) {
      for (const card of position[seat].players[owner].battlefield) delete card.blockingIds;
    }
  }
  const legacyPosition = await rewindForge({
    host_deck: blockFixtureConfig.decks[0], guest_deck: blockFixtureConfig.decks[1], seed: blockFixtureConfig.seed,
    checkpoint,
  }, position);
  t.after(() => legacyPosition.close());
  assert.deepEqual(legacyPosition.view('opponent'), view());

  await game.stop('player', 'afterBlockers', view().revision);
  await take(view().choices.find(choice => choice.label === 'Confirm blockers'));
  for (const seat of ['player', 'opponent']) {
    const confirmed = game.view(seat);
    const assigned = blocks(confirmed).flatMap(card => card.blockingIds);
    assert.equal(assigned.length, 2);
    assert.equal(assigned[0], assigned[1]);
    assert.ok(attacks(confirmed).some(card => card.id === assigned[0]));
    if (seat === 'player') assert.notEqual(assigned[0], first.block.attackerId);
  }
});
