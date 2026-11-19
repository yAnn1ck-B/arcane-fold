import type { CatalogCard } from "../lib/types";

export type Seat = 0 | 1;
export interface HistoryEntry {
  turn: number;
  text: string;
}
export const seats = [0, 1] as const;
export const manaTypes = ["W", "U", "B", "R", "G", "C"] as const;
export type Mana = (typeof manaTypes)[number];
export const zones = [
  "library",
  "hand",
  "battlefield",
  "graveyard",
  "exile",
  "command",
] as const;
export type Zone = (typeof zones)[number];
// Saved manual games store the index in this order.
export const turnPhases = [
  {
    name: "Beginning phase",
    steps: ["Untap step", "Upkeep step", "Draw step"],
  },
  { name: "Precombat main phase", steps: [] },
  {
    name: "Combat phase",
    steps: [
      "Beginning of combat step",
      "Declare attackers step",
      "Declare blockers step",
      "Combat damage step",
      "End of combat step",
    ],
  },
  { name: "Postcombat main phase", steps: [] },
  { name: "Ending phase", steps: ["End step", "Cleanup step"] },
];
export const steps = turnPhases.flatMap((phase) =>
  phase.steps.length ? phase.steps : [phase.name],
);
export type Combat = "attacking" | "blocking" | null;
export interface Piece {
  id: string;
  printing: string | null;
  tokenName: string | null;
  owner: Seat;
  controller: Seat;
  tapped: boolean;
  back: boolean;
  faceDown: boolean;
  faceDownVisibleTo?: Seat[];
  revealed: boolean;
  counters: Record<string, number>;
  attachedTo: string | null;
  combat: Combat;
  damage?: number;
  chosenType?: string;
  attachedToPlayer?: Seat;
  combatTargets?: string[];
  phasedOut?: boolean;
  summoningSick?: boolean;
  power?: number;
  toughness?: number;
}
export interface Player {
  deckName: string;
  life: number;
  counters?: Record<string, number>;
  mana: Record<Mana, number>;
  zones: Record<Zone, string[]>; // Library top is index 0.
  mulligans: number;
  openingBottom?: string[];
  kept: boolean;
}
export interface StackEntry {
  id: string;
  kind: "spell" | "ability" | "copy";
  label: string;
  description?: string;
  controller: Seat;
  card: string | null;
  source: string | null;
  targets: string; // Player-supplied target description.
  copyPrinting: string | null; // Retained if the original spell leaves the stack.
  copyKind: "spell" | "ability" | null;
  copyBack: boolean;
  copyFaceDown: boolean;
}
export interface Match {
  version: 1;
  players: [Player, Player];
  pieces: Record<string, Piece>;
  catalog: Record<string, CatalogCard>;
  stack: StackEntry[]; // Top is index 0.
  turn: number;
  active: Seat;
  step: number;
  firstStrikeDamage?: boolean;
  handoffDecision?: { seat: Seat; text: string; choices: string[] };
  nextId: number;
}
export interface PlayerView extends Player {
  counts: Record<Zone, number>;
}
export type MatchView = Omit<Match, "players" | "nextId"> & {
  viewer: Seat;
  players: [PlayerView, PlayerView];
};
export type Action =
  | { type: "finishDecision"; seat: Seat }
  | { type: "draw"; seat: Seat; count?: number }
  | { type: "shuffle" | "mulligan"; seat: Seat; order: string[] }
  | { type: "keep"; seat: Seat; bottom: string[] }
  | { type: "move"; id: string; zone: Zone; position?: "top" | "bottom" }
  | { type: "tap" | "flip" | "faceDown" | "reveal" | "control"; id: string }
  | { type: "tapMana"; id: string; mana: Mana; count: number }
  | { type: "untapAll" | "clearMana"; seat: Seat }
  | { type: "combat"; id: string; mark: Combat }
  | { type: "attach"; id: string; to: string | null }
  | { type: "counter"; id: string; name: string; delta: number }
  | { type: "playerCounter"; seat: Seat; name: string; delta: number }
  | { type: "token"; seat: Seat; name: string }
  | { type: "life"; seat: Seat; delta: number }
  | { type: "mana"; seat: Seat; mana: Mana; delta: number }
  | { type: "cast"; id: string; targets?: string }
  | { type: "ability"; id: string; label: string; targets?: string }
  | { type: "copy"; entry: string; seat: Seat; targets?: string }
  | { type: "targets"; entry: string; targets: string }
  | { type: "reorderStack"; entry: string; direction: "up" | "down" }
  | { type: "resolve" | "counterSpell"; entry: string; zone?: Zone }
  | { type: "nextStep" | "nextTurn" }
  | { type: "setStep"; step: number };
