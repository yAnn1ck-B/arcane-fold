import { invoke } from "@tauri-apps/api/core";
import type {
  BoosterOpening,
  CatalogCard,
  LeagueStatus,
  WildcardBalances,
} from "@/lib/types";

export function leagueStatus() {
  return invoke<LeagueStatus>("league_status");
}
export function beginLeague() {
  return invoke<LeagueStatus>("begin_league");
}
export function claimWeeklyReward() {
  return invoke<LeagueStatus>("claim_weekly_reward");
}
export function openBoosters(
  setCode: string,
  count: number,
  requestId: string,
) {
  return invoke<BoosterOpening>("open_boosters", { setCode, count, requestId });
}
export function craftCard(cardId: string, requestId: string) {
  return invoke<{ card: CatalogCard; wildcards: WildcardBalances }>(
    "craft_card",
    { cardId, requestId },
  );
}
