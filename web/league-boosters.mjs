import { randomInt } from "node:crypto";

export const rarities = ["common", "uncommon", "rare", "mythic"];
export const kinds = [...rarities, "discovery"];
export const emptyBalances = () => Object.fromEntries(kinds.map(kind => [kind, 0]));

function cardTypes(card) {
  return card.typeLine.split(" // ")[0].split("—")[0].trim().toLowerCase().split(/\s+/);
}
export function basic(card) {
  const types = cardTypes(card);
  return types.includes("land") && types.includes("basic");
}
export function craftable(card) {
  return card.eligible !== false && rarities.includes(card.rarity) && !basic(card) && !card.digital && !card.oversized &&
    (!card.games || card.games.includes("paper")) && !/\b(token|emblem)\b/i.test(card.typeLine);
}

// Group identities before sampling artwork so cards with many variants have equal odds.
export function boosterPool(cards, code, slots) {
  const grouped = Object.fromEntries(rarities.map(rarity => [rarity, new Map()]));
  for (const card of cards) {
    if (!craftable(card) || card.booster === false || card.promo) continue;
    const group = grouped[card.rarity];
    if (!group.has(card.oracleId)) group.set(card.oracleId, { oracleId: card.oracleId,
      land: cardTypes(card).includes("land"), printings: [] });
    group.get(card.oracleId).printings.push(card);
  }
  if (slots.basicLands !== 0) throw new Error("Free basic lands cannot occupy booster slots.");
  for (const [rarity, count] of [["common", slots.commons], ["uncommon", slots.uncommons], ["rare", slots.rareSlots]]) {
    if (count && !grouped[rarity].size) throw new Error(code.toUpperCase() + " has no eligible " + rarity + " booster cards.");
  }
  return Object.fromEntries(rarities.map(rarity => [rarity, Array.from(grouped[rarity].values())]));
}

export function drawPack(pools, rules, owned, random = () => randomInt(2 ** 32) / 2 ** 32) {
  const cards = [];
  const duplicateWildcards = emptyBalances();
  const seen = new Set();
  const slots = rules.booster;
  let lands = 0;
  function draw(rarity) {
    let eligible = pools[rarity].filter(group => (owned.get(group.oracleId) ?? 0) < 4);
    if (!eligible.length) { duplicateWildcards[rarity]++; return; }
    if (lands >= slots.preferredLandLimit && eligible.some(group => !group.land)) {
      eligible = eligible.filter(group => !group.land);
    }
    if (eligible.some(group => !seen.has(group.oracleId))) {
      eligible = eligible.filter(group => !seen.has(group.oracleId));
    }
    const weight = group => rarity === "common" && group.land ? slots.commonLandWeight : 1;
    let remaining = random() * eligible.reduce((sum, group) => sum + weight(group), 0);
    const chosen = eligible.find(group => (remaining -= weight(group)) < 0) ?? eligible.at(-1);
    cards.push({ ...chosen.printings[Math.floor(random() * chosen.printings.length)] });
    owned.set(chosen.oracleId, (owned.get(chosen.oracleId) ?? 0) + 1);
    seen.add(chosen.oracleId);
    if (chosen.land) lands++;
  }
  const mythics = Array.from({ length: slots.rareSlots }, () => pools.mythic.length > 0 &&
    random() < rules.mythicProbability).filter(Boolean).length;
  for (let i = 0; i < slots.rareSlots; i++) draw(i < mythics ? "mythic" : "rare");
  for (let i = 0; i < slots.uncommons; i++) draw("uncommon");
  for (let i = 0; i < slots.commons; i++) draw("common");
  cards.sort((a, b) => rarities.indexOf(a.rarity) - rarities.indexOf(b.rarity));
  return { cards, duplicateWildcards };
}
