import { invoke } from "@/services/league-transport";
import type {
  BoosterOpening,
  CatalogCard,
  LeagueStatus,
  WildcardBalances,
  WildcardKind,
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
export function craftCard(cardId: string, requestId: string, wildcardKind: WildcardKind) {
  return invoke<{ card: CatalogCard; wildcards: WildcardBalances }>(
    "craft_card",
    { cardId, requestId, wildcardKind },
  );
}

export function openNextBoosters(count: number, requestId: string) {
  return invoke<BoosterOpening>("open_next_boosters", { count, requestId });
}

export function resolveBoosterOpening(requestId: string, count: number, setCode?: string) {
  return invoke<BoosterOpening | null>("resolve_booster_opening", { requestId, count, setCode });
}
