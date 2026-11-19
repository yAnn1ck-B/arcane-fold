import type { ForgeCard } from "./forge-match";

function stateKey(card: ForgeCard) {
  const { id, counters = {}, ...state } = card;
  // Include all projected card state except the instance ID. Counter objects
  // may list the same counters in different insertion orders.
  return JSON.stringify([
    Object.entries(state).sort(([left], [right]) => left.localeCompare(right)),
    Object.entries(counters).sort(([left], [right]) => left.localeCompare(right)),
  ]);
}

export function groupBattlefieldCards(
  cards: readonly ForgeCard[],
  separateIds?: ReadonlySet<string | undefined>,
): ForgeCard[][] {
  const attachedHosts = new Set(cards.map((card) => card.attachedTo));
  const byState = new Map<string, ForgeCard[]>();
  const groups: ForgeCard[][] = [];

  for (const card of cards) {
    // These cards need their own position for hidden identity, links or choices.
    if (card.faceDown || card.groupingState === -1 || card.attacking || card.blocking || card.blockingIds?.length ||
        card.attachedTo || card.attachedToPlayer || attachedHosts.has(card.id) || separateIds?.has(card.id)) {
      groups.push([card]);
      continue;
    }

    const key = stateKey(card);
    const existing = byState.get(key);
    if (existing) {
      existing.push(card);
    } else {
      const group = [card];
      byState.set(key, group);
      groups.push(group);
    }
  }
  return groups;
}
