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
  blockingIds?: string[];
  summoningSick?: boolean;
  phasedOut?: boolean;
  grantedKeywords?: string[];
  cantAttack?: boolean;
  cantBlock?: boolean;
  power?: number;
  toughness?: number;
  target?: string;
  targetRefs?: { cardId?: string; seat?: ForgeSeat }[];
  description?: string;
  oracleText?: string;
  typeLine?: string;
  chosenType?: string;
  namedCards?: string[];
  chosenColors?: string[];
  manaCost?: string;
  damage?: number;
  counters?: Record<string, number>;
  groupingState?: number; // Snapshot-local equivalence, with -1 for an ungroupable card.
}

export interface ForgeChoice {
  id: string;
  manaAbility?: boolean;
  endTurnId?: string;
  passTurnId?: string;
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
  block?: { attackerId: string; remove: boolean; reassign?: boolean };
}

export interface ForgeDamageRecipient {
  cardId?: string;
  seat?: ForgeSeat;
  label: string;
  lethal: number;
  assigned: number;
  overflow?: true;
}

export interface ForgeDamageAssignment {
  choiceId: string;
  sourceCardId: string;
  sourceName: string;
  total: number;
  recipients: ForgeDamageRecipient[];
  deferId?: string;
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
  damageAssignment?: ForgeDamageAssignment;
  revealedToYou?: string[];
  players: Record<ForgeSeat, ForgePlayer>;
  stack: ForgeCard[];
  choices: ForgeChoice[];
}
