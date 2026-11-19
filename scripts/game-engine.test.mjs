import assert from "node:assert/strict";
import test from "node:test";
import { moduleUrl, deck } from "./game-test-support.mjs";
const {
  createMatch,
  applyAction,
  prepareShuffle,
  projectMatch,
  validateMatch,
  steps,
} = await import(moduleUrl("engine", { "./types": moduleUrl("types") }));
const { battlefieldGroup } = await import(moduleUrl("battlefield"));

test("battlefield areas use public current-face types with one place for each permanent", () => {
  for (const [card, group] of [
    [{ typeLine: "Legendary Artifact Creature — Construct" }, "Creatures"],
    [{ typeLine: "Artifact Land" }, "Lands"],
    [{ typeLine: "Legendary Enchantment Creature — God" }, "Creatures"],
    [{ typeLine: "Artifact - Treasure", token: true }, "Other permanents"],
    [{ typeLine: "Enchantment — Aura" }, "Other permanents"],
    [{ typeLine: "Legendary Planeswalker — Jace" }, "Other permanents"],
    [{ typeLine: "Battle — Siege // Creature — Dragon" }, "Other permanents"],
    [{ typeLine: "Battle — Siege // Creature — Dragon", back: true }, "Creatures"],
    [{ typeLine: "Basic Land — Island", faceDown: true }, "Other permanents"],
    [{ typeLine: "Basic Land — Island", faceDown: true, power: 2 }, "Creatures"],
    [{ token: true, power: 0 }, "Creatures"],
    [{ token: true }, "Other permanents"],
    [{}, "Other permanents"],
  ]) assert.equal(battlefieldGroup(card), group);
});

function fixture() {
  return createMatch([deck("a"), deck("b")]);
}

test("manual battlefield markers follow a creature through entry, turns, changes of control and zone changes", () => {
  let match = fixture();
  const [creature, hasty] = match.players[0].zones.hand;
  match.catalog[match.pieces[hasty].printing].oracleText = "Flying, haste";
  match = change(match, {type:"cast",id:creature});
  match = change(match, {type:"resolve",entry:match.stack[0].id});
  assert.equal(match.pieces[creature].summoningSick, true);
  match = change(match, {type:"move",id:hasty,zone:"battlefield"});
  assert.equal(match.pieces[hasty].summoningSick, undefined);
  match = change(match, {type:"markStatus",id:creature,status:"phasedOut",marked:true});
  assert.equal(projectMatch(match,1).pieces[creature].phasedOut,true);
  match = change(match, {type:"markStatus",id:creature,status:"phasedOut",marked:false});
  match = change(match, {type:"nextTurn"});
  assert.equal(match.pieces[creature].summoningSick,true);
  match = change(match, {type:"nextTurn"});
  assert.equal(match.pieces[creature].summoningSick,undefined);
  match = change(match, {type:"control",id:creature});
  assert.equal(match.pieces[creature].summoningSick,true);
  match = change(match, {type:"move",id:creature,zone:"hand"});
  assert.equal(match.pieces[creature].summoningSick,undefined);
  assert.throws(() => applyAction(match, {type:"markStatus",id:creature,status:"summoningSick",marked:true}));
});
function change(state, action) {
  const next = applyAction(state, action);
  assert.ok(
    validateMatch(JSON.parse(JSON.stringify(next))),
    action.type + " should be resumable",
  );
  return next;
}

test("an issue report freezes the reporting seat's view, choices and public history", async () => {
  const { captureForgeIssue, captureManualIssue, freezeGameIssue } = await import(moduleUrl("issue-report"));
  const match = fixture();
  const view = projectMatch(match, 1);
  const history = [{ turn: 1, text: "Game started" }];
  const manual = freezeGameIssue(captureManualIssue("game", 3, view, history), "test");
  assert.equal(manual.viewer, "opponent");
  assert.equal(manual.revision, 3);
  assert.deepEqual(manual.board.players[0].zones.hand, []);
  assert.deepEqual(manual.board.players[1].zones.library, []);
  const hidden = match.players[0].zones.hand[0];
  assert.ok(!Object.hasOwn(manual.board.pieces, hidden));
  assert.ok(!Object.hasOwn(manual.board.catalog, match.pieces[hidden].printing));
  history.push({ turn: 10, text: "Later event" });
  assert.equal(manual.history.length, 1);

  const position = {
    revision: 12, stack: [{ name: "Shock" }], choices: [{ id: "c1", label: "Respond" }],
    history: [{ turn: 2, text: "Shock was cast." }],
  };
  const forge = freezeGameIssue(captureForgeIssue("game", "player", position), "test", [{ label: "Pass" }], "Stack");
  position.stack.pop();
  position.choices[0].label = "Next";
  position.history.length = 0;
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

test("snapshots main-deck copies and creates a private view for either seat", () => {
  const decks = [deck("a"), deck("b")];
  const match = createMatch(decks);
  decks[0].cards[0].card.name = "edited";
  assert.equal(match.catalog.a0.name, "Name a0");
  assert.equal(match.catalog.sideboard, undefined);
  assert.equal(Object.keys(match.pieces).length, 24);
  assert.equal(validateMatch(match), true);
  for (const viewer of [0, 1]) {
    const view = projectMatch(match, viewer);
    assert.equal(view.players[viewer].zones.hand.length, 7);
    assert.equal(view.players[1 - viewer].zones.hand.length, 0);
    assert.equal(view.players[1 - viewer].counts.hand, 7);
    assert.equal(Object.keys(view.catalog).length, 7);
    for (const id of [
      ...match.players[1 - viewer].zones.hand,
      ...match.players[viewer].zones.library,
    ]) {
      assert.ok(!JSON.stringify(view).includes(id));
    }
  }
  const solo = createMatch([deck("a", 1), deck("b", 0)]);
  assert.equal(
    change(solo, { type: "keep", seat: 1, bottom: [] }).players[1].kept,
    true,
  );
});

test("London mulligans use captured shuffle outcomes, exact bottom order and atomic rejection", () => {
  let match = fixture();
  const shuffle = prepareShuffle(match, 0, true);
  const a = change(match, shuffle);
  assert.deepEqual(a, applyAction(match, shuffle));
  assert.deepEqual(a.players[0].zones.hand, shuffle.order.slice(0, 7));
  match = change(a, prepareShuffle(a, 0, true));
  const hand = match.players[0].zones.hand;
  assert.throws(() =>
    applyAction(match, { type: "keep", seat: 0, bottom: [hand[0], hand[0]] }),
  );
  assert.throws(() =>
    applyAction(match, { type: "shuffle", seat: 0, order: [] }),
  );
  const kept = change(match, {
    type: "keep",
    seat: 0,
    bottom: [hand[3], hand[1]],
  });
  assert.equal(kept.players[0].zones.hand.length, 5);
  assert.deepEqual(kept.players[0].zones.library.slice(-2), [hand[3], hand[1]]);
  assert.equal(match.players[0].zones.hand.length, 7);
  assert.throws(() => applyAction(kept, prepareShuffle(kept, 0, true)));
});

test("private look retains only original cards, reveal and shuffle change visibility", () => {
  let m = fixture();
  const [a, b] = projectMatch(m, 0, 2).players[0].zones.library;
  const seen = new Set([a, b]);
  m = change(m, { type: "move", id: a, zone: "hand" });
  assert.deepEqual(projectMatch(m, 0, seen).players[0].zones.library, [b]);
  m = change(m, { type: "reveal", id: b });
  assert.deepEqual(projectMatch(m, 1).players[0].zones.library, [b]);
  m = change(m, prepareShuffle(m, 0));
  assert.deepEqual(projectMatch(m, 1).players[0].zones.library, []);
  const oldest = m.players[0].zones.library[0];
  m = change(m, {
    type: "move",
    id: oldest,
    zone: "library",
    position: "bottom",
  });
  assert.equal(m.players[0].zones.library.at(-1), oldest);
});

test("a copied permanent survives a countered original; ability resolves without moving its source", () => {
  let m = fixture();
  const [id, source] = m.players[0].zones.hand;
  m = change(m, { type: "move", id: source, zone: "battlefield" });
  m = change(m, { type: "cast", id, targets: "seat 2" });
  const spell = m.stack[0].id;
  m = change(m, { type: "copy", entry: spell, seat: 1 });
  m = change(m, { type: "ability", id: source, label: "Draw a card" });
  assert.throws(() => applyAction(m, { type: "resolve", entry: spell }));
  m = change(m, { type: "counterSpell", entry: spell });
  assert.deepEqual(m.players[0].zones.graveyard, [id]);
  m = change(m, { type: "resolve", entry: m.stack[0].id });
  assert.deepEqual(m.players[0].zones.battlefield, [source]);
  m = change(m, { type: "resolve", entry: m.stack[0].id });
  const tokenId = m.players[1].zones.battlefield[0];
  assert.equal(m.pieces[tokenId].printing, m.pieces[id].printing);
  m = change(m, { type: "move", id: tokenId, zone: "graveyard" });
  assert.equal(m.pieces[tokenId], undefined);
});

test("an opponent copying a face-down instant sees only anonymous characteristics, through copy and resolution", () => {
  let m = fixture();
  const id = m.players[0].zones.hand[0];
  const hiddenPrinting = m.pieces[id].printing;
  m.catalog[hiddenPrinting].typeLine = "Instant";
  m = change(m, { type: "faceDown", id });
  m = change(m, { type: "cast", id });
  m = change(m, { type: "copy", seat: 1, entry: m.stack[0].id });
  m = change(m, { type: "copy", seat: 1, entry: m.stack[0].id });
  const opponent = projectMatch(m, 1);
  assert.equal(opponent.catalog[hiddenPrinting], undefined);
  assert.ok(opponent.stack.every((x) => x.label === "Face-down spell"));
  for (const seat of [0, 1]) {
    for (const copy of projectMatch(m, seat).stack.slice(0, 2)) {
      assert.equal(copy.copyPrinting, null);
      assert.equal(copy.source, null);
    }
  }
  for (let i = 0; i < 3; i++)
    m = change(m, { type: "resolve", entry: m.stack[0].id });
  assert.deepEqual(m.players[0].zones.battlefield, [id]);
  assert.equal(m.players[1].zones.battlefield.length, 2);
  assert.ok(
    !JSON.stringify(projectMatch(m, 1)).includes(
      m.catalog[hiddenPrinting].name + '"',
    ),
  );
  for (const token of m.players[1].zones.battlefield) {
    assert.equal(m.pieces[token].printing, null);
    assert.equal(m.pieces[token].tokenName, "2/2 creature");
  }
});

test("a back-face spell copy retains that face even if its original is countered", () => {
  for (const type of ["Instant // Creature", "Creature // Sorcery"]) {
    let m = fixture();
    const id = m.players[0].zones.hand[0];
    const card = m.catalog[m.pieces[id].printing];
    card.typeLine = type;
    card.name = "Front // Back";
    m = change(m, { type: "flip", id });
    m = change(m, { type: "cast", id });
    const original = m.stack[0].id;
    m = change(m, { type: "copy", seat: 1, entry: original });
    m = change(m, { type: "counterSpell", entry: original });
    assert.equal(m.stack[0].label, "Back");
    assert.equal(m.stack[0].copyBack, true);
    m = change(m, { type: "resolve", entry: m.stack[0].id });
    const field = m.players[1].zones.battlefield;
    if (type.endsWith("Sorcery")) {
      assert.equal(field.length, 0);
    } else {
      assert.equal(m.pieces[field[0]].back, true);
      assert.equal(m.pieces[field[0]].tokenName, "Back");
    }
  }
});

test("copying an ability never makes a token of its source, including copies of copies", () => {
  let m = fixture();
  const id = m.players[0].zones.hand[0];
  m = change(m, { type: "move", id, zone: "battlefield" });
  m = change(m, { type: "ability", id, label: "Add a counter" });
  for (let n = 0; n < 2; n++)
    m = change(m, { type: "copy", seat: 1, entry: m.stack[0].id });
  assert.ok(m.stack.slice(0, 2).every((x) => x.copyKind === "ability"));
  while (m.stack.length)
    m = change(m, {
      type: "resolve",
      entry: m.stack[0].id,
      zone: "battlefield",
    });
  assert.deepEqual(m.players[1].zones.battlefield, []);
  assert.deepEqual(m.players[0].zones.battlefield, [id]);
});

test("control changes, attachment cleanup, counters and token movement affect only match instances", () => {
  let m = fixture();
  const [id, aura] = m.players[0].zones.hand;
  for (const card of [id, aura])
    m = change(m, { type: "move", id: card, zone: "battlefield" });
  m = change(m, { type: "attach", id: aura, to: id });
  assert.throws(() => applyAction(m, { type: "attach", id, to: aura }));
  m = change(m, { type: "counter", id, name: "+1/+1", delta: 2 });
  m = change(m, { type: "control", id });
  assert.equal(m.pieces[id].owner, 0);
  assert.equal(m.pieces[id].counters["+1/+1"], 2);
  assert.deepEqual(m.players[1].zones.battlefield, [id]);
  m = change(m, { type: "faceDown", id });
  assert.equal(projectMatch(m, 0).pieces[id].printing, null);
  m = change(m, { type: "move", id, zone: "hand" });
  assert.equal(m.pieces[aura].attachedTo, null);
  assert.equal(m.pieces[id].controller, 0);
  assert.deepEqual(m.pieces[id].counters, {});
  assert.ok(m.players[0].zones.hand.includes(id));
});

test("turn progression, life and mana are seat-specific; corrupt saves are rejected", () => {
  let m = fixture();
  m = change(m, { type: "mana", seat: 1, mana: "C", delta: 3 });
  m = change(m, { type: "life", seat: 0, delta: -5 });
  m = change(m, { type: "setStep", step: steps.length - 1 });
  m = change(m, { type: "nextStep" });
  assert.equal(m.active, 1);
  assert.equal(m.step, 0);
  assert.equal(m.players[0].life, 15);
  assert.equal(m.players[1].mana.C, 3);
  assert.throws(() =>
    applyAction(m, { type: "mana", seat: 0, mana: "C", delta: -1 }),
  );
  m.players[0].zones.hand.push(m.players[1].zones.hand[0]);
  assert.equal(validateMatch(m), false);
  assert.equal(validateMatch({}), false);
  assert.equal(validateMatch(null), false);
});
