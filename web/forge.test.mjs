import assert from "node:assert/strict";
import test from "node:test";
import { createGame } from "./forge.mjs";
import { replayPrefix } from "./room-history.mjs";
import { decodePriority, encodePriority } from "./priority.mjs";
import prioritySteps from "./priority-steps.json" with { type: "json" };

test("priority checklists validate both sides, preserve exact windows and read earlier stop settings", () => {
  const config = {own:["draw","endStep"],opponent:["afterAttackers"]};
  assert.deepEqual(decodePriority(encodePriority(config)),config);
  const steps = Object.keys(prioritySteps);
  assert.deepEqual(decodePriority("full"),{own:steps,opponent:steps});
  const oldConfig = decodePriority("v2:draw:every,afterAttackers");
  assert.deepEqual(oldConfig,{own:["draw"],opponent:steps});
  oldConfig.opponent = oldConfig.opponent.filter(step => step !== "afterAttackers");
  assert.deepEqual(decodePriority(encodePriority(oldConfig)),oldConfig);
  assert.doesNotMatch(encodePriority({own:["every"],opponent:[]}),/every/);
  assert.deepEqual(decodePriority("endStep"),{own:["endStep"],opponent:["endStep"]});
  assert.deepEqual(decodePriority("next"),{own:[],opponent:[]});
  for (const bad of [null,{own:"full",opponent:[]},{own:["next"],opponent:[]},{own:["draw","draw"],opponent:[]}]) {
    assert.throws(() => encodePriority(bad),/Invalid priority/);
  }
});

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
  await game.stop("opponent", {own:["every"],opponent:["every"]}, 0);
  assert.deepEqual(decodePriority(game.view("player").priorityStop), {own:[],opponent:[]});
  const [next, duplicate] = await Promise.allSettled([game.act("player", keep, 0), game.act("player", keep, 0)]);
  assert.equal(next.status, "fulfilled");
  assert.equal(duplicate.status, "rejected");
  assert.equal(next.value.actor, "opponent");
  assert.equal(next.value.choices.length, 0);
  const current = game.view("opponent");
  const steps = Object.keys(prioritySteps);
  assert.deepEqual(decodePriority(current.priorityStop), {own:steps,opponent:steps});
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

test("the guest can play first and the starting seat survives a rewind and replay", {
  skip: !process.env.FORGE_INSTALL, timeout: 240_000,
}, async t => {
  const config = {
    decks: ["[main]\n16 Mountain\n", "[main]\n16 Forest\n"], seed: "814290991531",
  };
  const game = await createGame({ ...config, startingSeat: "opponent" });
  t.after(() => game.close());
  const keepHand = (engine, seat) => {
    const decision = engine.view(seat);
    assert.equal(decision.actor, seat);
    return engine.act(seat, decision.choices.find(choice => choice.label === "Keep hand").id);
  };
  await keepHand(game, "opponent");
  const earlier = game.checkpoint();
  const cursor = { version: earlier.version, initial: earlier.initial, moveCount: 1,
    lastMoveDigest: earlier.moves[0].after, pending: earlier.pending };
  await keepHand(game, "player");
  const firstTurn = game.view("opponent");
  assert.equal(firstTurn.turn, 1);
  assert.equal(firstTurn.active, "opponent");
  assert.equal(firstTurn.players.opponent.handCount, 7);
  assert.ok(firstTurn.choices.some(choice => choice.label === "Play Forest"));
  const journal = game.checkpoint();
  assert.equal(journal.startingSeat, "opponent");
  await game.close();

  const rewound = await createGame({ ...config, checkpoint: replayPrefix(journal, cursor) });
  t.after(() => rewound.close());
  await keepHand(rewound, "player");
  assert.deepEqual(rewound.view("opponent"), firstTurn);
  assert.deepEqual(rewound.checkpoint(), journal);
});
