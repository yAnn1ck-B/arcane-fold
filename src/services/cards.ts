import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  CatalogCard,
  CardQuery,
  CardQueryResult,
  CatalogProgress,
  CatalogSet,
  CardFilterOptions,
  CatalogStatus,
  ForgePaths,
} from "@/lib/types";

export const defaultCardQuery: CardQuery = {
  search: "",
  ownedOnly: false,
  color: "",
  rarity: "",
  setCode: "",
  typeLine: "",
  manaValue: "",
  minOwned: 0,
  page: 0,
  pageSize: 30,
  colors: [],
  manaValues: [],
  cardTypes: [],
  creatureType: "",
  groupByOracle: false,
  availableOnly: false,
  allocated: {},
};

export function queryCards(query: CardQuery) {
  return invoke<CardQueryResult>("query_cards", { query });
}
export function getCard(cardId: string) {
  return invoke<CatalogCard>("get_card", { cardId });
}
export function getCardFilterOptions(query: CardQuery) {
  return invoke<CardFilterOptions>("card_filter_options", { query });
}
export function searchCreatureTypes(query: CardQuery, search: string) {
  return invoke<string[]>("search_creature_types", { query, search });
}
export function getCardPrintings(oracleId: string) {
  return invoke<CatalogCard[]>("card_printings", { oracleId });
}
export function clearCardImageMemoryCache() {
  imageCache.clear();
}
export function catalogStatus() {
  return invoke<CatalogStatus>("catalog_status");
}
export function ensureCatalog(paths: ForgePaths) {
  return invoke<CatalogStatus>("ensure_catalog", { paths });
}
export function getBannerCard() {
  return invoke<CatalogCard>("get_banner_card");
}
export function getBannerMoxes() {
  return invoke<CatalogCard[]>("get_banner_moxes");
}
export function listSets() {
  return invoke<CatalogSet[]>("list_sets");
}
export function importCatalog(sourcePath?: string) {
  return invoke<CatalogStatus>("import_catalog", {
    sourcePath: sourcePath ?? null,
  });
}
export function onCatalogProgress(
  handler: (progress: CatalogProgress) => void,
) {
  return listen<CatalogProgress>("catalog-progress", (event) =>
    handler(event.payload),
  );
}

// Limit downloads and decoded images. Only visible cards request artwork.
const imageCache = new Map<string, Promise<string>>();
let active = 0;
const waiting: (() => void)[] = [];

async function queuedImage(
  cardId: string,
  imageCacheDir: string,
  face: "front" | "back",
) {
  if (active >= 3) await new Promise<void>((resolve) => waiting.push(resolve));
  active += 1;
  try {
    return await invoke<string>("resolve_card_image", {
      cardId,
      imageCacheDir,
      face,
    });
  } finally {
    active -= 1;
    waiting.shift()?.();
  }
}

export function resolveCardImage(
  cardId: string,
  imageCacheDir: string,
  face: "front" | "back" = "front",
) {
  const key = `${imageCacheDir}|${cardId}|${face}`;
  const existing = imageCache.get(key);
  if (existing) return existing;
  const request = queuedImage(cardId, imageCacheDir, face).catch(
    (error: unknown) => {
      imageCache.delete(key);
      throw error;
    },
  );
  imageCache.set(key, request);
  if (imageCache.size > 150) imageCache.delete(imageCache.keys().next().value!);
  return request;
}

export function invalidateCardImage(
  cardId: string,
  imageCacheDir: string,
  face: "front" | "back",
) {
  imageCache.delete(`${imageCacheDir}|${cardId}|${face}`);
}
