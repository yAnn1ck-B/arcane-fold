import assert from "node:assert/strict";
import test from "node:test";
import { moduleUrl, deck } from "./playtest-test-support.mjs";

const types = moduleUrl("types");
const engine = moduleUrl("engine", { "./types": types });
const guard = moduleUrl("validate-action", { "./types": types });
const history = moduleUrl("manual-history", { "./engine": engine });
const { createMatch, prepareShuffle } = await import(engine);
const { newSession, restoreSession, playAction, undoAction } = await import(
  moduleUrl("session", { "./engine": engine, "./validate-action": guard, "./manual-history": history })
);
const fresh = () => newSession(createMatch([deck("a"), deck("b")]));
const save = (session) => JSON.parse(JSON.stringify(session.saved));

test("reopening and undo preserve the original private shuffle outcome", () => {
  const opening = fresh();
  const shuffled = playAction(opening, prepareShuffle(opening.match, 0));
  const drawn = playAction(shuffled, { type: "draw", seat: 0 });
  const resumed = restoreSession(save(drawn));
  assert.deepEqual(resumed.match, drawn.match);
  const undone = undoAction(resumed);
  assert.deepEqual(undone.match, shuffled.match);
  assert.deepEqual(undoAction(undone).match, opening.match);
  assert.notEqual(undone.saved.revision, resumed.saved.revision);
  assert.equal(undone.saved.id, resumed.saved.id);
});

test("compaction checkpoints the oldest actions and preserves all remaining undo steps", () => {
  let session = fresh();
  const limit = 128;
  for (let i = 0; i < limit + 3; i++)
    session = playAction(session, { type: "life", seat: 0, delta: -1 });
  assert.equal(session.saved.actions.length, limit);
  assert.equal(session.saved.base.players[0].life, 17);
  assert.equal(session.history.length, limit + 4);
  const fullHistory = session.history;
  session = restoreSession(save(session));
  assert.deepEqual(session.history, fullHistory);
  assert.equal(session.match.players[0].life, 17 - limit);
  while (session.saved.actions.length) session = undoAction(session);
  assert.equal(session.match.players[0].life, 17);
  assert.deepEqual(session.history, fullHistory.slice(0, 4));
  assert.throws(() => undoAction(session), /undo/);
});

test("legacy saves recover their retained history and public entries protect hidden cards", () => {
  const game = fresh();
  const card = game.match.players[0].zones.library[0];
  const name = game.match.catalog[game.match.pieces[card].printing].name;
  const drawn = playAction(game, { type: "draw", seat: 0 });
  const legacy = save(drawn);
  delete legacy.earlierHistory;
  const resumed = restoreSession(legacy);
  assert.deepEqual(resumed.history, [{ turn: 1, text: "Player 1 drew a card." }]);
  const back = playAction(resumed, { type: "move", id: card, zone: "library" });
  assert.ok(!JSON.stringify(back.history).includes(name));
  const faceDown = playAction(resumed, { type: "faceDown", id: card });
  const cast = playAction(faceDown, { type: "cast", id: card });
  assert.ok(!JSON.stringify(cast.history).includes(name));
  const resolved = playAction(cast, { type: "resolve", entry: cast.match.stack[0].id });
  const faceUp = playAction(resolved, { type: "faceDown", id: card });
  assert.ok(!JSON.stringify(resolved.history).includes(name));
  assert.equal(faceUp.history.at(-1).text, `Player 1 turned ${name} face up.`);
  const revealed = playAction(resumed, { type: "reveal", id: card });
  assert.ok(revealed.history.at(-1).text.includes(name));
  assert.deepEqual(undoAction(revealed).history, resumed.history);
});

test("restore rejects corrupt journals, malformed arguments, and actions that break card conservation", () => {
  const original = fresh();
  const id = original.match.players[0].zones.hand[0];
  for (const action of [
    null,
    { type: "unknown" },
    { type: "nextStep", seat: 42 },
    { type: "life", seat: "0", delta: 2 },
    { type: "life", seat: 2, delta: 2 },
    { type: "mana", seat: 0, mana: "X", delta: 3 },
    { type: "move", id, zone: "library", position: "mid" },
    { type: "shuffle", seat: 0, order: [id] },
    { type: "draw", seat: 0, count: null },
    { type: "attach", id, to: 0 },
    { type: "combat", id, mark: "oops" },
  ]) {
    const value = save(original);
    value.actions.push(action);
    assert.throws(() => restoreSession(value), JSON.stringify(action));
  }
  for (const mutate of [
    (value) => {
      value.format = 2;
    },
    (value) => {
      value.base.players[0].zones.library = [];
    },
    (value) => {
      value.actions = Array(129).fill({ type: "nextStep" });
    },
  ]) {
    const value = save(original);
    mutate(value);
    assert.throws(() => restoreSession(value));
  }
  assert.deepEqual(restoreSession(save(original)).match, original.match);
});
