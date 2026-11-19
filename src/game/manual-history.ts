import { cleanName, locate, steps } from "./engine";
import type { Action, HistoryEntry, Match, Seat, StackEntry } from "./types";

const player = (seat: Seat) => `Player ${seat + 1}`;

function publicName(match: Match, id: string) {
  const card = match.pieces[id];
  if (!card) return;
  const zone = locate(match, id)?.zone;
  if (!card.revealed && (zone === "hand" || zone === "library")) return;
  if (card.faceDown && !card.revealed) return "a face-down card";
  return cleanName(card, match);
}

function stackName(match: Match, item: StackEntry) {
  if (item.copyFaceDown) return "a face-down spell";
  return item.card ? publicName(match, item.card) ?? "a spell" : item.label;
}

function actionText(before: Match, action: Action, after: Match): string {
  switch (action.type) {
    case "finishDecision":
      return `${player(action.seat)} finished the pending decision.`;
    case "draw": {
      const n = action.count ?? 1;
      return `${player(action.seat)} drew ${n === 1 ? "a card" : n + " cards"}.`;
    }
    case "shuffle":
      return `${player(action.seat)} shuffled their library.`;
    case "mulligan":
      return `${player(action.seat)} took a mulligan.`;
    case "keep":
      return `${player(action.seat)} kept ${after.players[action.seat].zones.hand.length} cards.`;
    case "move": {
      const name =
        publicName(after, action.id) ??
        publicName(before, action.id) ??
        "a card";
      const source = locate(before, action.id)!;
      const destination =
        action.zone === "library"
          ? `the ${action.position ?? "top"} of the library`
          : action.zone;
      return `${player(source.seat)} moved ${name} from ${source.zone} to ${destination}.`;
    }
    case "life":
      return `${player(action.seat)} went from ${before.players[action.seat].life} to ${after.players[action.seat].life} life.`;
    case "playerCounter":
      return `${player(action.seat)} now has ${after.players[action.seat].counters?.[action.name.trim()] ?? 0} ${action.name.trim()} counters.`;
    case "mana":
      return `${player(action.seat)} ${action.delta >= 0 ? "added" : "spent"} ${Math.abs(action.delta)} ${action.mana} mana.`;
    case "clearMana":
      return `${player(action.seat)} emptied their mana pool.`;
    case "untapAll":
      return `${player(action.seat)} untapped their permanents.`;
    case "token":
      return `${player(action.seat)} created ${action.name.trim()}.`;
    case "nextStep":
    case "nextTurn":
    case "setStep":
      return `${player(after.active)} entered the ${steps[after.step].toLowerCase()}.`;
    case "cast":
    case "ability": {
      const item = after.stack[0];
      const target = item.targets ? ` targeting ${item.targets}` : "";
      const what =
        action.type === "cast"
          ? `cast ${stackName(after, item)}`
          : `activated ${publicName(before, action.id) ?? "a card"} (${item.label})`;
      return `${player(item.controller)} ${what}${target}.`;
    }
    case "copy":
      return `${player(action.seat)} copied ${stackName(after, after.stack[0])}.`;
    case "targets":
    case "reorderStack":
    case "resolve":
    case "counterSpell": {
      const item = before.stack.find((entry) => entry.id === action.entry)!;
      const name = stackName(before, item);
      if (action.type === "targets")
        return action.targets.trim()
          ? `${name} now targets ${action.targets.trim()}.`
          : `Cleared the targets for ${name}.`;
      if (action.type === "reorderStack")
        return `Moved ${name} ${action.direction} on the stack.`;
      return action.type === "resolve"
        ? `Resolved ${name}.`
        : `Countered ${name}.`;
    }
    default: {
      const card = after.pieces[action.id];
      const who = player(card.controller);
      const name =
        publicName(after, action.id) ??
        publicName(before, action.id) ??
        "a card";
      switch (action.type) {
        case "tap":
          return `${who} ${card.tapped ? "tapped" : "untapped"} ${name}.`;
        case "tapMana":
          return `${who} tapped ${name} for ${action.count} ${action.mana} mana.`;
        case "flip":
          return `${who} flipped ${name}.`;
        case "faceDown": {
          const visibleSide = card.faceDown ? before : after;
          return `${who} turned ${publicName(visibleSide, action.id) ?? "a card"} ${card.faceDown ? "face down" : "face up"}.`;
        }
        case "reveal":
          return `${who} ${card.revealed ? "revealed" : "concealed"} ${name}.`;
        case "control":
          return `${who} took control of ${name}.`;
        case "counter": {
          const n = Math.abs(action.delta);
          return `${who} ${action.delta >= 0 ? "put" : "removed"} ${n} ${action.name.trim()} ${n === 1 ? "counter" : "counters"} ${action.delta >= 0 ? "on" : "from"} ${name}.`;
        }
        case "combat":
          return card.combat
            ? `${who} marked ${name} as ${card.combat}.`
            : `${who} removed ${name} from combat.`;
        case "attach":
          return action.to
            ? `${who} attached ${name} to ${publicName(after, action.to) ?? "a card"}.`
            : `${who} detached ${name}.`;
      }
    }
  }
}

export function describeAction(
  before: Match,
  action: Action,
  after: Match,
): HistoryEntry {
  return { turn: after.turn, text: actionText(before, action, after) };
}
