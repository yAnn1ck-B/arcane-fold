import { invoke } from "@tauri-apps/api/core";
import type { HistoryEntry, Match } from "./types";

export type ForgeSeat = "player" | "opponent";

export const prioritySteps = {
  upkeep: "Upkeep",
  draw: "After the draw",
  precombatMain: "First main phase",
  beginCombat: "Before attackers",
  afterAttackers: "After attackers",
  afterBlockers: "After blockers",
  firstStrikeDamage: "After first-strike damage",
  combatDamage: "After combat damage",
  endCombat: "End of combat",
  postcombatMain: "Second main phase",
  endStep: "End step",
} as const;
export type PriorityStop = "auto" | "next" | "full" | keyof typeof prioritySteps;

export interface ForgeCard {
  id: string;
  name: string;
  faceDown?: boolean;
  token?: boolean;
  attachedTo?: string;
  attachedToPlayer?: ForgeSeat;
  tapped: boolean;
  setCode?: string;
  collectorNumber?: string;
  attacking?: boolean;
  blocking?: boolean;
  power?: number;
  toughness?: number;
  target?: string;
  description?: string;
  oracleText?: string;
  typeLine?: string;
  chosenType?: string;
  namedCards?: string[];
  chosenColors?: string[];
  manaCost?: string;
  damage?: number;
  counters?: Record<string, number>;
}

export interface ForgeChoice {
  id: string;
  label: string;
  kind:
    | "card"
    | "ability"
    | "type"
    | "name"
    | "target"
    | "pass"
    | "option"
    | "attack"
    | "block";
  cardId?: string;
  seat?: ForgeSeat;
}

interface ForgePlayer {
  life: number;
  mana: number;
  libraryCount?: number;
  libraryTop?: ForgeCard;
  handCount: number;
  hand: ForgeCard[];
  battlefield: ForgeCard[];
  graveyard: ForgeCard[];
  exile?: ForgeCard[];
}

export interface ForgeMatch {
  history: HistoryEntry[];
  canUndo: boolean;
  revision: number;
  priorityStop: PriorityStop;
  sharedSeats: boolean;
  stage: "decision" | "finished";
  prompt: string;
  active: ForgeSeat;
  actor: ForgeSeat;
  turn: number;
  phase: string;
  step?: string;
  librarySearch?: { title: string; operation?: string; cards: ForgeCard[] };
  revealedToYou?: string[];
  players: Record<ForgeSeat, ForgePlayer>;
  stack: ForgeCard[];
  choices: ForgeChoice[];
}

export function startForge(
  sessionId: string,
  deckId: string,
  opponentDeckId?: string,
) {
  return invoke<ForgeMatch>("start_game", {
    sessionId,
    deckId,
    opponentDeckId,
  });
}

export function chooseForge(
  sessionId: string,
  action: string,
  viewer: ForgeSeat,
  revision: number,
) {
  return invoke<ForgeMatch>("act_game", {
    sessionId,
    action,
    viewer,
    revision,
  });
}

export function undoForge(
  sessionId: string,
  viewer: ForgeSeat,
  revision: number,
) {
  return invoke<ForgeMatch>("undo_game_action", {
    sessionId,
    viewer,
    revision,
  });
}

export function viewForgeSeat(sessionId: string, viewer: ForgeSeat) {
  return invoke<ForgeMatch>("view_game_seat", { sessionId, viewer });
}

export function setForgePriorityStop(
  sessionId: string,
  viewer: ForgeSeat,
  revision: number,
  stop: PriorityStop,
) {
  return invoke<ForgeMatch>("set_game_priority_stop", { sessionId, viewer, revision, stop });
}

export function stopForge(sessionId: string) {
  return invoke<void>("end_game", { sessionId });
}

export function exportForgeManual(sessionId: string, revision: number) {
  return invoke<{ match: Match; history: HistoryEntry[] }>(
    "export_manual_game",
    { sessionId, revision },
  );
}
