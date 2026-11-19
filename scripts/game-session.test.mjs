import assert from "node:assert/strict";
import test from "node:test";
import { moduleUrl, deck } from "./game-test-support.mjs";

const types = moduleUrl("types");
const engine = moduleUrl("engine", { "./types": types });
const guard = moduleUrl("validate-action", { "./types": types });
const history = moduleUrl("manual-history", { "./engine": engine });
const { createMatch, prepareShuffle, projectMatch } = await import(engine);
const { newSession, restoreSession, playAction, undoAction } = await import(
  moduleUrl("session", { "./engine": engine, "./validate-action": guard, "./manual-history": history })
);
const fresh = () => newSession(createMatch([deck("a"), deck("b")]));
const save = (session) => JSON.parse(JSON.stringify(session.saved));

test("a game issue freezes the reporting seat, choices and public history at the captured revision", async () => {
  const { captureForgeIssue, captureManualIssue, freezeGameIssue } = await import(moduleUrl("issue-report"));
  const session = fresh();
  const view = projectMatch(session.match, 1);
  const manual = freezeGameIssue(captureManualIssue(session.saved.id, session.saved.revision, view, session.history), "test");
  assert.equal(manual.viewer, "opponent");
  assert.equal(manual.revision, session.saved.revision);
  assert.deepEqual(manual.board.players[0].zones.hand, []);
  assert.deepEqual(manual.board.players[1].zones.library, []);
  const hidden = session.match.players[0].zones.hand[0];
  assert.ok(!Object.hasOwn(manual.board.pieces, hidden));
  assert.ok(!Object.hasOwn(manual.board.catalog, session.match.pieces[hidden].printing));
  session.history.push({ turn: 10, text: "Later event" });
  assert.ok(!manual.history.some((entry) => entry.turn === 10));
  const position = { revision: 12, stack: [{ name: "Shock" }], choices: [{ id: "c1", label: "Respond" }], history: [{ turn: 2, text: "Shock was cast." }] };
  const forge = freezeGameIssue(captureForgeIssue("game", "player", position), "test", [{ label: "Pass" }], "Stack");
  position.stack.pop(); position.choices[0].label = "Next"; position.history.length = 0;
  assert.deepEqual(forge.board.stack, [{ name: "Shock" }]);
  assert.equal(forge.actions[0].label, "Respond");
  assert.equal(forge.visibleControls[0].label, "Pass");
  assert.equal(forge.visibleDialog, "Stack");
  assert.equal(forge.history[0].text, "Shock was cast.");
  assert.equal(forge.id.length, 36);
  assert.equal(forge.revision, 12);
  const failed = captureForgeIssue("game", "player", null, "Forge could not start.");
  assert.equal(failed.board, null);
  assert.equal(failed.error, "Forge could not start.");
});

test("manually tapping for a chosen color saves and undoes the tap and pool together", () => {
  const game = fresh();
  const id = game.match.players[0].zones.hand[0];
  const table = playAction(game, { type: "move", id, zone: "battlefield" });
  const action = { type: "tapMana", id, mana: "U", count: 2 };
  const next = restoreSession(save(playAction(table, action)));
  assert.equal(next.match.pieces[id].tapped, true);
  assert.equal(next.match.players[0].mana.U, 2);
  assert.match(next.history.at(-1).text, /tapped .+ for 2 U mana/);
  assert.throws(() => playAction(next, action), /already tapped/);
  assert.throws(() => playAction(table, { ...action, count: 0 }), /positive/);
  assert.deepEqual(undoAction(next).match, table.match);
});

test("handoff keeps private choices and a public pregame log across save, resume and manual Undo", () => {
  const match = createMatch([deck("a"), deck("b")]);
  const first = match.players[0];
  first.kept = true;
  const second = match.players[1];
  second.mulligans = 2;
  second.openingBottom = second.zones.hand.slice(0, 1);
  const entries = [{ turn: 0, text: "Player 1 kept their opening hand." }];
  const session = restoreSession(save(newSession(match, entries)));
  assert.deepEqual(session.history, entries);
  assert.throws(() => undoAction(session), /undo/);
  assert.equal(projectMatch(match, 0).players[1].openingBottom, undefined);
  assert.deepEqual(projectMatch(match, 1).players[1].openingBottom, second.openingBottom);
  const bottom = second.zones.hand.slice(0, 2);
  const kept = playAction(session, { type: "keep", seat: 1, bottom });
  assert.deepEqual(kept.match.players[1].zones.library.slice(-2), bottom);
  assert.equal(kept.match.players[1].openingBottom, undefined);
  assert.deepEqual(undoAction(restoreSession(save(kept))).match, match);
});

test("imported command zone, face-down exile, counters and pending decisions respect seat views", () => {
  const match = createMatch([deck("a"), deck("b")]);
  const player = match.players[0];
  const concealed = player.zones.hand.pop();
  player.zones.exile.push(concealed);
  Object.assign(match.pieces[concealed], { faceDown: true, faceDownVisibleTo: [], chosenType: "Elf" });
  const emblem = player.zones.hand.pop();
  player.zones.command.push(emblem);
  player.counters = { Poison: 3 };
  match.handoffDecision = { seat: 1, text: "Choose a card", choices: ["Private choice"] };
  const game = restoreSession(save(newSession(match, [])));
  assert.deepEqual(projectMatch(game.match, 0).players[0].zones.command, [emblem]);
  assert.equal(projectMatch(game.match, 0).handoffDecision, undefined);
  assert.deepEqual(projectMatch(game.match, 1).handoffDecision, match.handoffDecision);
  for (const seat of [0, 1]) {
    const hidden = projectMatch(game.match, seat).pieces[concealed];
    assert.equal(hidden.printing, null);
    assert.equal(hidden.chosenType, undefined);
  }
  const reduced = playAction(game, { type: "playerCounter", seat: 0, name: "Poison", delta: -1 });
  assert.equal(reduced.match.players[0].counters.Poison, 2);
  const resolved = playAction(reduced, { type: "finishDecision", seat: 1 });
  assert.equal(resolved.match.handoffDecision, undefined);
  assert.ok(!JSON.stringify(resolved.history).includes("Private choice"));
  assert.deepEqual(undoAction(resolved).match.handoffDecision, match.handoffDecision);
  const legacy = save(fresh());
  for (const player of legacy.base.players) delete player.zones.command;
  delete legacy.requiredOpening;
  assert.equal(projectMatch(restoreSession(legacy).match, 0).players[0].counts.command, 0);
});

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
