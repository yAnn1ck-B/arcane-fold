import assert from "node:assert/strict";
import test from "node:test";
import { createGame } from "./forge.mjs";

test("separate network seats retain private opening hands, priority and verified replay", {
  skip: !process.env.FORGE_INSTALL, timeout: 240_000,
}, async t => {
  const config = {
    decks: ["[main]\n16 Mountain\n", "[main]\n16 Forest\n"], seed: "814290991531",
  };
  const game = await createGame(config);
  t.after(() => game.close());
  const first = game.view("player");
  const waiting = game.view("opponent");
  assert.equal(first.players.player.hand.length, 7);
  assert.equal(waiting.players.opponent.hand.length, 7);
  assert.equal(waiting.choices.length, 0);
  assert.equal(first.players.opponent.hand.length, 0);
  assert.doesNotMatch(JSON.stringify(first), /Forest|replayState|libraryTopBySeat|priorityStops/);
  assert.doesNotMatch(JSON.stringify(waiting), /Mountain|Keep hand|librarySearch|replayState/);
  const keep = first.choices.find(choice => choice.label === "Keep hand").id;
  await assert.rejects(game.act("opponent", keep, 0), /unavailable/);
  await assert.rejects(game.act("player", keep + "\nEXPORT_MANUAL 4", 0), /unavailable/);
  await game.stop("opponent", "full", 0);
  assert.equal(game.view("player").priorityStop, "auto");
  const [next, duplicate] = await Promise.allSettled([game.act("player", keep, 0), game.act("player", keep, 0)]);
  assert.equal(next.status, "fulfilled");
  assert.equal(duplicate.status, "rejected");
  assert.equal(next.value.actor, "opponent");
  assert.equal(next.value.choices.length, 0);
  const current = game.view("opponent");
  assert.equal(current.priorityStop, "full");
  const keepTwo = current.choices.find(choice => choice.label === "Keep hand").id;
  await game.act("opponent", keepTwo, current.revision);
  await game.stop("player", "afterBlockers", 2);
  const views = [game.view("player"), game.view("opponent")];
  const saved = game.checkpoint();
  await game.close();
  const resumed = await createGame({ ...config, checkpoint: saved });
  t.after(() => resumed.close());
  assert.deepEqual([resumed.view("player"), resumed.view("opponent")], views);
  assert.deepEqual(resumed.checkpoint(), saved);
  const corrupted = structuredClone(saved);
  corrupted.moves[1].after = "different";
  await assert.rejects(createGame({ ...config, checkpoint: corrupted }), /reproduce a saved decision/);
});
