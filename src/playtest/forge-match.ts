import { invoke } from "@tauri-apps/api/core";
import type { HistoryEntry } from "./types";

export type Scenario =
  | "bolt"
  | "response"
  | "deck"
  | "combat"
  | "growth"
  | "library";
export type ForgeSeat = "player" | "opponent";

export interface ForgeCard {
  id: string;
  name: string;
  faceDown?: boolean;
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

// The original two-card regression has a fixed command and snapshot format.
// Adapt that format at the IPC boundary so it uses the regular Forge board.
interface BoltPosition {
  history: HistoryEntry[];
  canUndo: boolean;
  revision: number;
  stage:
    | "ready"
    | "landPlayed"
    | "chooseTarget"
    | "opponentPriority"
    | "resolved";
  playerLife: number;
  opponentLife: number;
  hand: string[];
  battlefield: string[];
  opponentBattlefield?: string[];
  stack: string[];
  graveyard: string[];
  mountainTapped: boolean;
  mana: number;
  legalTargets: ForgeSeat[];
  target: ForgeSeat | null;
}

function boltMatch(position: BoltPosition): ForgeMatch {
  const cards = (names: string[], tapped = false): ForgeCard[] =>
    names.map((name) => ({ id: name, name, tapped, setCode: "M10" }));
  const choices: ForgeChoice[] = [];
  let prompt: string;
  switch (position.stage) {
    case "ready":
      prompt = "Play Mountain from your hand.";
      choices.push({
        id: "playMountain",
        kind: "card",
        label: "Play Mountain",
        cardId: "Mountain",
      });
      break;
    case "landPlayed":
      prompt = "Cast Lightning Bolt from your hand.";
      choices.push({
        id: "castBolt",
        kind: "card",
        label: "Cast Lightning Bolt",
        cardId: "Lightning Bolt",
      });
      break;
    case "chooseTarget":
      prompt = "Choose a target for Lightning Bolt.";
      for (const seat of position.legalTargets) {
        choices.push({
          id: seat === "player" ? "targetPlayer" : "targetOpponent",
          kind: "target",
          label: seat === "player" ? "Target yourself" : "Target opponent",
          seat,
        });
      }
      break;
    case "opponentPriority":
      prompt = "The opponent has priority. Pass to let Lightning Bolt resolve.";
      choices.push({
        id: "passPriority",
        label: "Pass priority",
        kind: "pass",
      });
      break;
    case "resolved":
      prompt = "Lightning Bolt resolved.";
      break;
  }
  const stack = cards(position.stack);
  if (stack[0] && position.target) {
    stack[0].target = position.target === "player" ? "you" : "opponent";
  }
  return {
    sharedSeats: false,
    history: position.history,
    canUndo: position.canUndo,
    revision: position.revision,
    stage: position.stage === "resolved" ? "finished" : "decision",
    actor: position.stage === "opponentPriority" ? "opponent" : "player",
    active: "player",
    turn: 1,
    phase: "Precombat main phase",
    prompt,
    choices,
    stack,
    players: {
      player: {
        life: position.playerLife,
        mana: position.mana,
        hand: cards(position.hand),
        handCount: position.hand.length,
        battlefield: cards(position.battlefield, position.mountainTapped),
        graveyard: cards(position.graveyard),
      },
      opponent: {
        life: position.opponentLife,
        mana: 0,
        hand: [],
        handCount: 0,
        battlefield: cards(position.opponentBattlefield ?? []),
        graveyard: [],
      },
    },
  };
}

export async function startForge(
  sessionId: string,
  scenario: Scenario,
  deckId?: string,
  opponentDeckId?: string,
) {
  if (scenario === "bolt") {
    return boltMatch(
      await invoke<BoltPosition>("start_bolt_trial", { sessionId }),
    );
  }
  return invoke<ForgeMatch>("start_bolt_trial", {
    sessionId,
    scenario,
    deckId,
    opponentDeckId,
  });
}

export async function chooseForge(
  sessionId: string,
  scenario: Scenario,
  action: string,
  viewer: ForgeSeat,
  revision: number,
) {
  const args = { sessionId, action, viewer, revision };
  if (scenario === "bolt") {
    return boltMatch(await invoke<BoltPosition>("act_bolt_trial", args));
  }
  return invoke<ForgeMatch>("act_bolt_trial", args);
}

export async function undoForge(
  sessionId: string,
  scenario: Scenario,
  viewer: ForgeSeat,
  revision: number,
) {
  const args = { sessionId, viewer, revision };
  if (scenario === "bolt") {
    return boltMatch(await invoke<BoltPosition>("undo_forge_action", args));
  }
  return invoke<ForgeMatch>("undo_forge_action", args);
}

export function viewForgeSeat(sessionId: string, viewer: ForgeSeat) {
  return invoke<ForgeMatch>("view_forge_seat", { sessionId, viewer });
}

export function stopForge(sessionId: string) {
  return invoke<void>("stop_bolt_trial", { sessionId });
}
