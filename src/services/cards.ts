import { invoke } from "@/services/league-transport";
import type {
  CatalogCard,
  CardQuery,
  CardQueryResult,
  CatalogSet,
  CardFilterOptions,
  CatalogStatus,
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
export function catalogStatus() {
  return invoke<CatalogStatus>("catalog_status");
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
