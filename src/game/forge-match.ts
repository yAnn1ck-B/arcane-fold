import type { HistoryEntry, Mana } from "./types";
import prioritySteps from "../../web/priority-steps.json";

export type ForgeSeat = "player" | "opponent";

export { prioritySteps };
export type PriorityWindow = keyof typeof prioritySteps;
export interface PriorityStop { own: PriorityWindow[]; opponent: PriorityWindow[] }

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
  summoningSick?: boolean;
  phasedOut?: boolean;
  grantedKeywords?: string[];
  cantAttack?: boolean;
  cantBlock?: boolean;
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
  manaAbility?: boolean;
  endTurnId?: string;
  label: string;
  kind:
    | "card"
    | "ability"
    | "type"
    | "name"
    | "manaColor"
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
  manaByColor?: Record<Mana, number>;
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
