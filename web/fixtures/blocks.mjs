import assert from 'node:assert/strict';
import { createGame } from '../forge.mjs';

export const blockFixtureConfig = {
  decks: Array(2).fill('[Main]\n19 Forest|FDN\n15 Llanowar Elves|FDN\n'),
  seed: '814290991531',
};

export async function startBlockingFixture() {
  const game = await createGame(blockFixtureConfig);
  try {
    for (let index = 0; index < 160; index++) {
      const actor = game.view('player').actor;
      const state = game.view(actor);
      const defenders = state.players.opponent.battlefield.filter(card => card.name === 'Llanowar Elves' && !card.tapped);
      if (state.choices.some(choice => choice.block)) {
        assert.equal(actor, 'opponent');
        assert.ok(defenders.length >= 2);
        return game;
      }
      const attacking = state.players.player.battlefield.filter(card => card.attacking).length;
      const attackers = state.choices.filter(choice => choice.kind === 'attack' && choice.label.startsWith('Attack '));
      const chooseAttackers = actor === 'player' && defenders.length >= 2 && (attackers.length + attacking >= 2);
      const attack = chooseAttackers && attacking < 2 ? attackers[0] : undefined;
      const next = attack
        ?? state.choices.find(choice => choice.label === 'Keep hand' || choice.label.startsWith('Play '))
        ?? state.choices.find(choice => choice.label === 'Cast Llanowar Elves')
        ?? state.choices.find(choice => ['No attacks', 'Confirm attackers', 'No blocks'].includes(choice.label))
        ?? state.choices.find(choice => choice.kind === 'pass' || choice.label.startsWith('Discard '));
      assert.ok(next, state.prompt);
      await game.act(actor, next.id, state.revision);
    }
    throw new Error('Could not reach duplicate-attackers blocking fixture.');
  } catch (error) {
    await game.close();
    throw error;
  }
}
