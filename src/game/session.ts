import { applyAction, validateMatch } from "./engine";
import { validAction } from "./validate-action";
import { describeAction } from "./manual-history";
import type { Action, HistoryEntry, Match } from "./types";

// A private, local checkpoint plus the last actions. Shuffle actions include
// their chosen order, so replay and undo never draw fresh randomness.
const historyLimit = 128;
export interface SavedTable {
  format: 1;
  id: string;
  revision: string;
  base: Match;
  actions: Action[];
  requiredOpening?: boolean;
  // Public events that predate the undo checkpoint. Older saves lack this field.
  earlierHistory?: HistoryEntry[];
}

export interface Session {
  saved: SavedTable;
  match: Match;
  history: HistoryEntry[];
}

export function newSession(
  match: Match,
  history: HistoryEntry[] = [
    { turn: match.turn, text: `Player ${match.active + 1} plays first.` },
  ],
): Session {
  return {
    saved: {
      format: 1,
      id: crypto.randomUUID(),
      revision: crypto.randomUUID(),
      base: match,
      actions: [],
      requiredOpening: match.players.some(
        (player) => !player.kept && player.zones.hand.length > 0,
      ),
      earlierHistory: history,
    },
    match,
    history,
  };
}

export function restoreSession(value: unknown): Session {
  const saved = value as SavedTable | null;
  if (
    !saved ||
    saved.format !== 1 ||
    typeof saved.id !== "string" ||
    typeof saved.revision !== "string" ||
    !validateMatch(saved.base) ||
    !Array.isArray(saved.actions) ||
    (saved.requiredOpening !== undefined &&
      typeof saved.requiredOpening !== "boolean") ||
    saved.actions.length > historyLimit ||
    !saved.actions.every(validAction) ||
    (saved.earlierHistory !== undefined &&
      (!Array.isArray(saved.earlierHistory) ||
        !saved.earlierHistory.every(
          (entry) =>
            entry &&
            Number.isSafeInteger(entry.turn) &&
            entry.turn >= 0 &&
            typeof entry.text === "string",
        )))
  ) {
    throw new Error("This saved table could not be read.");
  }
  let match = saved.base;
  const history = [...(saved.earlierHistory ?? [])];
  for (const action of saved.actions) {
    const next = applyAction(match, action);
    history.push(describeAction(match, action, next));
    match = next;
  }
  if (!validateMatch(match))
    throw new Error("The saved actions could not be replayed.");
  return { saved, match, history };
}

export function playAction(session: Session, action: Action): Session {
  const match = applyAction(session.match, action);
  const actions = [...session.saved.actions, action];
  let base = session.saved.base;
  let earlierHistory = session.saved.earlierHistory ?? [];
  if (actions.length > historyLimit) {
    base = applyAction(base, actions.shift()!);
    earlierHistory = [
      ...earlierHistory,
      session.history[earlierHistory.length],
    ];
  }
  return {
    match,
    history: [...session.history, describeAction(session.match, action, match)],
    saved: {
      ...session.saved,
      base,
      actions,
      earlierHistory,
      revision: crypto.randomUUID(),
    },
  };
}

export function undoAction({ saved, history }: Session): Session {
  if (!saved.actions.length)
    throw new Error("There are no more actions to undo.");
  const actions = saved.actions.slice(0, -1);
  return {
    match: actions.reduce(applyAction, saved.base),
    history: history.slice(0, -1),
    saved: { ...saved, actions, revision: crypto.randomUUID() },
  };
}
