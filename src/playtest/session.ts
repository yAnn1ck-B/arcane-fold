import { applyAction, validateMatch } from "./engine";
import { validAction } from "./validate-action";
import type { Action, Match } from "./types";

// A private, local checkpoint plus the last actions. Shuffle actions include
// their chosen order, so replay and undo never draw fresh randomness.
const historyLimit = 128;
export interface SavedTable {
  format: 1;
  id: string;
  revision: string;
  base: Match;
  actions: Action[];
}

export interface Session {
  saved: SavedTable;
  match: Match;
}

export function newSession(match: Match): Session {
  return {
    saved: {
      format: 1,
      id: crypto.randomUUID(),
      revision: crypto.randomUUID(),
      base: match,
      actions: [],
    },
    match,
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
    saved.actions.length > historyLimit ||
    !saved.actions.every(validAction)
  ) {
    throw new Error("This saved table could not be read.");
  }
  const match = saved.actions.reduce(applyAction, saved.base);
  if (!validateMatch(match))
    throw new Error("The saved actions could not be replayed.");
  return { saved, match };
}

export function playAction(session: Session, action: Action): Session {
  const match = applyAction(session.match, action);
  const actions = [...session.saved.actions, action];
  let base = session.saved.base;
  if (actions.length > historyLimit) base = applyAction(base, actions.shift()!);
  return {
    match,
    saved: { ...session.saved, base, actions, revision: crypto.randomUUID() },
  };
}

export function undoAction({ saved }: Session): Session {
  if (!saved.actions.length)
    throw new Error("There are no more actions to undo.");
  const actions = saved.actions.slice(0, -1);
  return {
    match: actions.reduce(applyAction, saved.base),
    saved: { ...saved, actions, revision: crypto.randomUUID() },
  };
}
