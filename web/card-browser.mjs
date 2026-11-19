import { basic } from "./league-boosters.mjs";

const mainTypes = ["Artifact", "Battle", "Creature", "Enchantment", "Instant", "Kindred", "Land", "Planeswalker", "Sorcery"];
const colorOrder = ["W", "U", "B", "R", "G", "C", "M"];
const rarityOrder = ["common", "uncommon", "rare", "mythic", "special", "bonus"];
const lower = value => String(value ?? "").toLowerCase();
const words = value => String(value ?? "").trim().split(/\s+/).filter(Boolean);
const ordered = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const typeFaces = card => card.typeLine.split(" // ").map(face => face.split("—"));
const types = card => typeFaces(card).flatMap(([main]) => words(main).map(type => type === "Tribal" ? "Kindred" : type));
const creatureTypes = card => typeFaces(card).flatMap(([main, subtypes]) =>
  words(main).includes("Creature") ? (subtypes?.trim().match(/Time Lord|\S+/g) ?? []) : []);
const colors = card => !card.colors.length ? ["C"] : card.colors.length > 1 ? [...card.colors, "M"] : card.colors;
const manaBucket = card => Math.min(6, Math.floor(card.cmc));
const comparePrinting = (a,b) => ordered(a.setCode,b.setCode) || ordered(a.collectorNumber,b.collectorNumber) || ordered(a.id,b.id);
export const preferPrinting = (a,b) => Number(b.owned > 0) - Number(a.owned > 0) || comparePrinting(a,b);

// Caller supplies the currently unlocked, eligible catalog with this player's ownership.
function matches(card, query, scopeOnly) {
  const free = query.includeBasicLands && basic(card);
  if (!free && ((query.ownedOnly && !card.oracleOwned) || card.oracleOwned < (query.minOwned || 0)
    || (query.availableOnly && card.oracleOwned <= Math.max(0, query.allocated?.[card.oracleId] || 0)))) return false;
  const search = lower(card.name) + "\n" + lower(card.oracleText);
  if (!words(lower(query.search)).every(term => search.includes(term))) return false;
  if (scopeOnly) return true;
  const requestedColors = (query.colors?.length ? query.colors : [query.color]).filter(value => colorOrder.includes(value));
  if (requestedColors.length && !requestedColors.some(color => colors(card).includes(color))) return false;
  if (query.rarity && query.rarity !== "all" && lower(query.rarity) !== card.rarity) return false;
  if (query.setCode && query.setCode !== "all" && lower(query.setCode) !== card.setCode) return false;
  if (query.cardTypes?.length) {
    if (!query.cardTypes.some(type => types(card).includes(type === "Tribal" ? "Kindred" : type))) return false;
  } else if (lower(query.typeLine) === "basic land") {
    if (!basic(card)) return false;
  } else if (query.typeLine && query.typeLine !== "all" && !lower(card.typeLine).includes(lower(query.typeLine))) return false;
  if (query.creatureType && !creatureTypes(card).some(type => lower(type) === lower(query.creatureType))) return false;
  if (query.manaValues?.length) return query.manaValues.some(value => value === 6 ? card.cmc >= 6 : card.cmc === value);
  return !query.manaValue || (query.manaValue === "all") || Number(query.manaValue) === card.cmc;
}

export function queryCards(cards, query = {}) {
  let filtered = cards.filter(card => matches(card, query, false));
  if (query.groupByOracle) {
    const groups = new Map();
    for (const card of filtered) {
      const other = groups.get(card.oracleId);
      if (!other || preferPrinting(card, other) < 0) groups.set(card.oracleId, card);
    }
    filtered = [...groups.values()];
  }
  filtered.sort((a,b) => ordered(lower(a.name),lower(b.name)) || comparePrinting(a,b));
  const size = Math.min(100, Math.max(1, Math.trunc(query.pageSize) || 30));
  const offset = Math.max(0, Math.trunc(query.page) || 0) * size;
  return { total: filtered.length, cards: filtered.slice(offset, offset + size) };
}

export function filterOptions(cards, query = {}) {
  const scoped = cards.filter(card => matches(card, query, true));
  const seenColors = new Set(), seenMana = new Set(), seenRarities = new Set(), seenTypes = new Set(), sets = new Map();
  for (const card of scoped) {
    colors(card).forEach(color => seenColors.add(color));
    types(card).forEach(type => seenTypes.add(type));
    seenMana.add(manaBucket(card)); seenRarities.add(card.rarity);
    if (!sets.has(card.setCode)) sets.set(card.setCode, { name: card.setName, oracles: new Set() });
    sets.get(card.setCode).oracles.add(card.oracleId);
  }
  return { colors: colorOrder.filter(color => seenColors.has(color)), manaValues: [...seenMana].sort((a,b) => a-b),
    rarities: rarityOrder.filter(rarity => seenRarities.has(rarity)), cardTypes: mainTypes.filter(type => seenTypes.has(type)),
    sets: [...sets].map(([code, {name, oracles}]) => ({code, name, count: oracles.size})).sort((a,b) => ordered(lower(a.name),lower(b.name)) || ordered(a.code,b.code)) };
}

export function creatureSuggestions(cards, query, search) {
  const term = lower(search).trim();
  if (term.length < 2) return [];
  const names = cards.filter(card => matches(card, {...query, creatureType: ""}, false)).flatMap(creatureTypes);
  return [...new Set(names.filter(type => lower(type).includes(term)))].sort((a,b) => ordered(lower(a),lower(b))).slice(0,30);
}
