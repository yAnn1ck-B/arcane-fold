import assert from "node:assert/strict";
import test from "node:test";
import { deck, moduleUrl } from "../scripts/game-test-support.mjs";
import { createGame } from "./forge.mjs";
import { applyManual, createManual, manualView } from "./manual.mjs";

const { createMatch, validateMatch } = await import(moduleUrl("engine", { "./types": moduleUrl("types") }));

test("remote manual play authorizes seat actions and protects hidden cards across handoff, looks and shuffles", () => {
  const match = createMatch([deck("red"), deck("green")]);
  const original = structuredClone(match);
  const initial = createManual({ match, history: [], actor: "opponent" });
  assert.deepEqual(match, original);
  const first = manualView(initial, "player");
  assert.equal(first.actor, "opponent");
  assert.doesNotMatch(JSON.stringify(first), /green/);
  assert.deepEqual(first.view.players[1].zones.hand, []);
  assert.equal(first.view.players[1].counts.hand, 7);
  assert.ok(first.view.players[0].zones.hand.every(id => !(id in original.pieces)));
  assert.throws(() => applyManual(initial, "player", { type: "keep", seat: 0, bottom: [] }), /unavailable/);
  const firstKept = applyManual(initial, "opponent", { type: "keep", seat: 1, bottom: [] });
  const ready = applyManual(firstKept, "player", { type: "keep", seat: 0, bottom: [] });
  const otherCard = ready.match.players[1].zones.hand[0];
  assert.throws(() => applyManual(ready, "player", { type: "move", id: otherCard, zone: "exile" }), /unavailable/);
  assert.throws(() => applyManual(ready, "opponent", { type: "nextTurn" }), /unavailable/);
  assert.throws(() => applyManual(ready, "player", { type: "life", seat: 1, delta: -1 }), /unavailable/);
  const looking = applyManual(ready, "player", { type: "look", count: 2 });
  const seen = manualView(looking, "player").view.players[0].zones.library;
  assert.equal(seen.length, 2);
  assert.deepEqual(manualView(looking, "opponent").view.players[0].zones.library, []);
  assert.throws(() => applyManual(looking, "player", { type: "move", id: looking.match.players[0].zones.library[2], zone: "hand" }), /unavailable/);
  assert.throws(() => applyManual(looking, "player", { type: "shuffle", seat: 0, order: seen }), /unavailable/);
  const shuffled = applyManual(looking, "player", { type: "shuffle", seat: 0 });
  assert.equal(manualView(shuffled, "player").view.players[0].zones.library.length, 0);
  assert.ok(seen.every(id => !(id in shuffled.match.pieces)));
  assert.ok(validateMatch(shuffled.match));
  const publicCard = shuffled.match.players[0].zones.hand[0];
  const played = applyManual(shuffled, "player", { type: "move", id: publicCard, zone: "battlefield" });
  assert.deepEqual(manualView(played, "opponent").view.players[0].zones.battlefield, [publicCard]);
  assert.throws(() => applyManual(played, "opponent", { type: "tap", id: publicCard }), /unavailable/);
  const pending = createManual({ match: { ...played.match, handoffDecision: { seat: 1, text: "Private scry", choices: ["Keep Green Insight"] } }, actor: "opponent", history: [] });
  assert.doesNotMatch(JSON.stringify(manualView(pending, "player")), /Private scry|Green Insight/);
  assert.throws(() => applyManual(pending, "player", { type: "draw", seat: 0 }), /unavailable/);
  const completed = applyManual(pending, "opponent", { type: "finishDecision", seat: 1 });
  assert.equal(manualView(completed, "player").actor, null);
});

test("a running Forge game exports its opening and played land without advancing the journal", {
  skip: !process.env.FORGE_INSTALL, timeout: 180_000,
}, async t => {
  const game = await createGame({
    decks: ["[main]\n16 Mountain\n", "[main]\n16 Forest\n"], seed: "814290991531",
  });
  t.after(() => game.close());
  const before = game.checkpoint();
  const opening = createManual(await game.exportManual());
  assert.deepEqual(game.checkpoint(), before);
  const red = manualView(opening, "player");
  assert.equal(red.view.players[0].zones.hand.length, 7);
  assert.equal(red.actor, "player");
  assert.doesNotMatch(JSON.stringify(red), /Forest|forge-card-|replayState/);
  for (const seat of ["player", "opponent"]) {
    const state = game.view(seat);
    await game.act(seat, state.choices.find(choice => choice.label === "Keep hand").id);
  }
  const state = game.view("player");
  const land = state.choices.find(choice => choice.label.includes("Mountain"));
  assert.ok(land, "Forge offers playing a land");
  await game.act("player", land.id);
  const projected = game.view("opponent");
  const afterLand = game.checkpoint();
  const handedOff = createManual(await game.exportManual());
  const green = manualView(handedOff, "opponent");
  assert.equal(green.requiredOpening, false);
  assert.equal(green.view.turn, projected.turn);
  assert.equal(green.view.players[0].counts.battlefield, 1);
  assert.equal(green.view.players[0].counts.hand, projected.players.player.handCount);
  assert.deepEqual(green.view.players[0].zones.hand, []);
  assert.match(green.history.map(entry => entry.text).join(" "), /played Mountain/);
  assert.deepEqual(game.checkpoint(), afterLand);
});
