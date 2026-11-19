import type { ForgeMatch, ForgeSeat } from "./forge-match";
import type { HistoryEntry, MatchView } from "./types";

export interface IssueAction {
  label: string;
  id?: string;
  disabled?: boolean;
}

export interface IssuePosition {
  mode: "forge" | "manual";
  matchId: string;
  revision: number | string | null;
  viewer: ForgeSeat;
  board: unknown;
  actions: IssueAction[];
  history: HistoryEntry[];
  error?: string;
}

export interface GameIssueReport extends IssuePosition {
  schemaVersion: 1;
  id: string;
  capturedAt: string;
  appVersion: string;
  engineVersion: string;
  expectedBehavior: string;
  visibleControls: IssueAction[];
  visibleDialog?: string;
}

/** Pass only the seat view supplied to ForgeBoard, including for remote games. */
export function captureForgeIssue(matchId: string, viewer: ForgeSeat, match: ForgeMatch | null, error?: string): IssuePosition {
  const { choices, history, ...board } = match ?? { choices: [], history: [] };
  return {
    mode: "forge", matchId, viewer, revision: match?.revision ?? null,
    board: match ? board : null, actions: choices, history, error,
  };
}

/** A manual save contains both libraries and hands. Only the projected table belongs in a report. */
export function captureManualIssue(matchId: string, revision: string, view: MatchView, history: HistoryEntry[], error?: string): IssuePosition {
  const { catalog, ...board } = view;
  const printings = Object.fromEntries(Object.entries(catalog).map(([id, card]) => [id, {
    name: card.name, setCode: card.setCode, collectorNumber: card.collectorNumber,
    typeLine: card.typeLine, manaCost: card.manaCost, oracleText: card.oracleText,
  }]));
  return {
    mode: "manual", matchId, revision, viewer: view.viewer === 0 ? "player" : "opponent",
    board: { ...board, catalog: printings },
    actions: (view.handoffDecision?.choices ?? []).map((label) => ({ label })), history, error,
  };
}

export function freezeGameIssue(position: IssuePosition, appVersion: string, visibleControls: IssueAction[] = [], visibleDialog?: string): GameIssueReport {
  return structuredClone({
    ...position, schemaVersion: 1 as const, id: crypto.randomUUID(), capturedAt: new Date().toISOString(),
    engineVersion: position.mode === "forge" ? "Forge Desktop 2.0.13" : "Manual table v1",
    appVersion, visibleControls, visibleDialog, expectedBehavior: "",
  });
}
