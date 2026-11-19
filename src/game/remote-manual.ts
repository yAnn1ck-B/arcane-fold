import { applyAction, locate, prepareShuffle, projectMatch, validateMatch } from "./engine";
import { describeAction } from "./manual-history";
import { validAction } from "./validate-action";
import { seats, steps, zones, type Action, type HistoryEntry, type Match, type MatchView, type Seat } from "./types";
import type { ForgeSeat } from "./forge-match";

export type ManualCommand = Exclude<Action, { type: "shuffle" | "mulligan" }> |
  { type: "shuffle" | "mulligan"; seat: Seat } | { type: "look"; count: number | "all" };
export interface ManualState {
  mode: "manual";
  view: MatchView;
  history: HistoryEntry[];
  looking: boolean;
  requiredOpening: boolean;
  actor: ForgeSeat | null;
  stage: "decision" | "finished";
  turn: number;
  phase: string;
}
interface Checkpoint {
  mode: "manual";
  match: Match;
  history: HistoryEntry[];
  looked: [string[], string[]];
  firstOpeningSeat: Seat;
}
const names = ["player", "opponent"] as const;
function seatIndex(seat: ForgeSeat): Seat {
  if (seat === "player") return 0;
  if (seat === "opponent") return 1;
  throw new Error("Unknown manual seat.");
}
function openingSeat(state: Checkpoint) {
  const first = state.firstOpeningSeat;
  const other: Seat = first === 0 ? 1 : 0;
  return [first, other].find(seat => !state.match.players[seat].kept && state.match.players[seat].zones.hand.length > 0);
}

// Forge numbers physical instances in deck order. Give each physical card an opaque
// identity before either browser sees it. Refresh those identities on hidden shuffles.
function rekey(match: Match, ids: string[]) {
  const keys = new Map(ids.filter(id => match.pieces[id].tokenName === null)
    .map(id => [id, crypto.randomUUID()]));
  const key = (id: string) => keys.get(id) ?? id;
  for (const [old, id] of keys) {
    const piece = match.pieces[old];
    piece.id = id;
    match.pieces[id] = piece;
    delete match.pieces[old];
  }
  for (const piece of Object.values(match.pieces)) {
    if (piece.attachedTo) piece.attachedTo = key(piece.attachedTo);
    if (piece.combatTargets) piece.combatTargets = piece.combatTargets.map(key);
  }
  for (const player of match.players) {
    for (const zone of zones) player.zones[zone] = (player.zones[zone] ?? []).map(key);
    if (player.openingBottom) player.openingBottom = player.openingBottom.map(key);
  }
  for (const entry of match.stack) {
    if (entry.card) entry.card = key(entry.card);
    if (entry.source) entry.source = key(entry.source);
    entry.targets = entry.targets.replace(/\s*\(forge-card-\d+\)/g, "");
  }
}
export function createManual(exported: {match: Match; history: HistoryEntry[]; actor: ForgeSeat}): Checkpoint {
  if (!validateMatch(exported.match) || !Array.isArray(exported.history) ||
      exported.history.some(row => typeof row?.text !== "string" || !Number.isSafeInteger(row.turn))) {
    throw new Error("The suspended Forge position could not be opened as a manual game.");
  }
  const match = structuredClone(exported.match);
  rekey(match, Object.keys(match.pieces));
  return { mode: "manual", match, history: [...exported.history, {turn: match.turn, text: "Both players switched to manual play."}],
    looked: [[], []], firstOpeningSeat: seatIndex(exported.actor) };
}
export function manualView(state: Checkpoint, seat: ForgeSeat): ManualState {
  const viewer = seatIndex(seat);
  const opening = openingSeat(state);
  const actor = opening ?? state.match.handoffDecision?.seat;
  const view = projectMatch(state.match, viewer, new Set(state.looked[viewer]));
  const other = viewer === 0 ? 1 : 0;
  view.players[other].deckName = "Player " + (other + 1);
  return { mode: "manual", stage: "decision", turn: state.match.turn, phase: steps[state.match.step],
    view, history: state.history, looking: state.looked[viewer].length > 0,
    requiredOpening: opening !== undefined, actor: actor === undefined ? null : names[actor] };
}
function denied(): never {
  throw new Error("That manual action is unavailable to this seat.");
}
export function applyManual(state: Checkpoint, seat: ForgeSeat, command: ManualCommand): Checkpoint {
  const viewer = seatIndex(seat);
  if (!command || typeof command !== "object") return denied();
  const opening = openingSeat(state);
  if (opening !== undefined && (viewer !== opening || command.type !== "keep" && command.type !== "mulligan")) return denied();
  if (opening === undefined && state.match.handoffDecision && viewer !== state.match.handoffDecision.seat) return denied();
  const looked: [string[], string[]] = [[...state.looked[0]], [...state.looked[1]]];
  if (command.type === "look") {
    if (Object.keys(command).length !== 2 ||
        command.count !== "all" && (!Number.isSafeInteger(command.count) || command.count < 0)) return denied();
    const library = state.match.players[viewer].zones.library;
    looked[viewer] = library.slice(0, command.count === "all" ? library.length : command.count);
    return { ...state, looked };
  }
  let action: Action;
  if (command.type === "shuffle" || command.type === "mulligan") {
    if (Object.keys(command).length !== 2 || command.seat !== viewer) return denied();
    action = prepareShuffle(state.match, viewer, command.type === "mulligan");
  } else {
    if (!validAction(command)) return denied();
    action = command;
  }
  if ("seat" in action && action.seat !== viewer) return denied();
  const view = projectMatch(state.match, viewer, new Set(looked[viewer]));
  if ("id" in action) {
    const location = locate(state.match, action.id);
    if (!Object.hasOwn(view.pieces, action.id) || location?.seat !== viewer) return denied();
  }
  if (action.type === "attach" && action.to !== null && !Object.hasOwn(view.pieces, action.to)) return denied();
  if ("entry" in action && !view.stack.some(entry => entry.id === action.entry)) return denied();
  if (["setStep", "nextStep", "nextTurn"].includes(action.type) &&
      (state.match.active !== viewer || state.match.handoffDecision)) return denied();
  const match = applyAction(state.match, action);
  const entry = describeAction(state.match, action, match);
  if (action.type === "shuffle" || action.type === "mulligan") {
    const {library, hand} = match.players[viewer].zones;
    rekey(match, action.type === "mulligan" ? [...library, ...hand] : library);
    looked[viewer] = [];
  }
  for (const s of seats) {
    const library = new Set(match.players[s].zones.library);
    looked[s] = looked[s].filter(id => library.has(id));
  }
  return { ...state, match, looked, history: [...state.history, entry] };
}
