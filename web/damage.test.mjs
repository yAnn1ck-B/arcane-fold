import assert from 'node:assert/strict';
import test from 'node:test';
import { createGame } from './forge.mjs';
import { rewindForge } from './room-history.mjs';

const installed = {skip:!process.env.FORGE_INSTALL,timeout:180_000};
const blockerNames = ['Llanowar Elves', "Dwynen's Elite"];

function configFor(attacker, land) {
  return {
    decks:[`[Main]\n17 ${land}|FDN\n16 ${attacker}|FDN\n`,
      `[Main]\n17 Forest|FDN\n10 ${blockerNames[0]}|FDN\n10 ${blockerNames[1]}|FDN\n`],
    seed:'814290991531',
  };
}

function decision(game) {
  return game.view(game.view('player').actor);
}

async function reachDamage(game, attacker) {
  for (let i=0; i<180; i++) {
    const {actor,revision,choices,players,damageAssignment} = decision(game);
    if (damageAssignment) return damageAssignment;
    const ready = players.opponent.battlefield.filter(card => !card.tapped);
    let next;
    if (choices.some(choice => choice.block)) {
      const count = ready.filter(card => card.blockingIds?.length).length;
      next = count === 2 ? choices.find(c => c.label === 'Confirm blockers')
        : choices.find(c => c.block && !c.block.remove && !c.block.reassign &&
          ready.some(card => card.id === c.cardId && card.name === blockerNames[count]));
    } else if (actor === 'player' && blockerNames.every(name => ready.some(card => card.name === name)) &&
        !players.player.battlefield.some(card => card.attacking)) {
      next = choices.find(c => c.kind === 'attack' && c.label.startsWith('Attack ') && c.label.endsWith(attacker));
    }
    next ??= choices.find(c => c.label === 'Keep hand' || c.label.startsWith('Play '))
      ?? choices.find(c => c.label.startsWith('Cast ') && !players[actor].battlefield.some(card => c.label === `Cast ${card.name}`))
      ?? choices.find(c => ['No attacks', 'No blocks', 'Confirm attackers', 'Confirm blockers'].includes(c.label))
      ?? choices.find(c => c.kind === 'pass' || c.label.startsWith('Discard '));
    assert.ok(next, `${decision(game).prompt}: ${choices.map(c => c.label).join(', ')}`);
    await game.act(actor, next.id, revision);
  }
  assert.fail('Could not reach combat damage.');
}

test('one combat damage allocation replaces an earlier incremental choice and replays exactly', installed, async t => {
  const config = configFor('Brazen Scourge','Mountain');
  const game = await createGame(config);
  t.after(() => game.close());
  const damage = await reachDamage(game,'Brazen Scourge');
  assert.equal(damage.total,3);
  assert.equal(damage.sourceName,'Brazen Scourge');
  const player = game.view('player');
  assert.ok(player.players.player.battlefield.some(card => card.id === damage.sourceCardId && card.attacking));
  for (const recipient of damage.recipients) {
    assert.ok(player.players.opponent.battlefield.some(card => card.id === recipient.cardId && card.name === recipient.label));
  }
  assert.equal(game.view('opponent').damageAssignment,undefined);
  assert.equal(damage.recipients.length,2);
  for (const amounts of ['1', '1,1', '4,0', '-1,4', '01,2', '1,2,0', '1,2\n']) {
    await assert.rejects(game.act('player',`${damage.choiceId}|${amounts}`,player.revision),/unavailable/);
  }
  await assert.rejects(game.act('opponent',`${damage.choiceId}|1,2`,player.revision),/unavailable/);
  assert.deepEqual(game.view('player'),player);

  const oldChoice = player.choices.find(c => c.label === 'Assign 1 to Llanowar Elves');
  await game.act('player',oldChoice.id,player.revision);
  const partial = game.view('player');
  assert.equal(partial.damageAssignment.recipients.find(r => r.label === 'Llanowar Elves').assigned,1);
  const checkpoint = game.checkpoint();
  const savedView = {...partial};
  delete savedView.damageAssignment;
  const position = {player:savedView,opponent:game.view('opponent'),replay_cursor:{
    version:checkpoint.version,initial:checkpoint.initial,moveCount:checkpoint.moves.length,
    lastMoveDigest:checkpoint.moves.at(-1).after,pending:checkpoint.pending,
  }};
  await game.close();
  const resumed = await rewindForge({host_deck:config.decks[0],guest_deck:config.decks[1],seed:config.seed,checkpoint},position);
  t.after(() => resumed.close());
  assert.deepEqual(resumed.view('player'),partial);

  const split = partial.damageAssignment.recipients.map(row => row.label === "Dwynen's Elite" ? 2 : 1).join(',');
  const after = await resumed.act('player',`${partial.damageAssignment.choiceId}|${split}`,partial.revision);
  assert.equal(after.revision,partial.revision+1);
  assert.equal(after.damageAssignment,undefined);
  assert.ok(after.players.player.graveyard.some(card => card.id === damage.sourceCardId));
  assert.ok(damage.recipients.every(row => after.players.opponent.graveyard.some(card => card.id === row.cardId)));
  const atomicCheckpoint = resumed.checkpoint();
  await resumed.close();
  const replayed = await createGame({...config,checkpoint:atomicCheckpoint});
  t.after(() => replayed.close());
  assert.deepEqual(replayed.view('player'),after);
});

test('trample allocation accepts overflow only after assigning lethal to both blockers', installed, async t => {
  const game = await createGame(configFor('Rampaging Baloths','Forest'));
  t.after(() => game.close());
  const damage = await reachDamage(game,'Rampaging Baloths');
  const player = game.view('player');
  assert.equal(damage.total,6);
  assert.equal(damage.recipients.at(-1).seat,'opponent');
  assert.equal(damage.recipients.at(-1).overflow,true);
  assert.deepEqual(damage.recipients.filter(row => !row.overflow).map(row => row.lethal).sort(),[1,2]);
  await assert.rejects(game.act('player',`${damage.choiceId}|0,0,6`,player.revision),/unavailable/);
  const amounts = damage.recipients.map(row => row.overflow ? 3 : row.lethal).join(',');
  const after = await game.act('player',`${damage.choiceId}|${amounts}`,player.revision);
  assert.equal(after.players.opponent.life,player.players.opponent.life-3);
  assert.ok(damage.recipients.filter(row => !row.overflow).every(row =>
    after.players.opponent.graveyard.some(card => card.id === row.cardId)));
});
