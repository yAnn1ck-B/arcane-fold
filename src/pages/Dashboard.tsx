import { useEffect, useState } from "react";
import {
  ArrowRight,
  CalendarDays,
  Layers3,
  Sparkles,
  Swords,
  TriangleAlert,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { listDecks } from "@/services/decks";
import CardImage from "@/components/CardImage";
import { listSets } from "@/services/cards";
import type {
  AppSettings,
  DashboardStats,
  DeckSummary,
  CatalogCard,
  CatalogSet,
  LeagueStatus,
} from "@/lib/types";

interface DashboardProps {
  settings: AppSettings;
  stats: DashboardStats;
  bannerCard?: CatalogCard | null;
  catalogCount: number;
  onCollection: () => void;
  onDecks: () => void;
  league: LeagueStatus;
  onBoosters: () => void;
  revision: number;
}

export default function Dashboard({
  settings,
  stats,
  bannerCard,
  catalogCount,
  onCollection,
  onDecks,
  league,
  onBoosters,
  revision,
}: DashboardProps) {
  const [sets, setSets] = useState<CatalogSet[]>([]);
  const [recentDecks, setRecentDecks] = useState<DeckSummary[]>([]);
  const [deckError, setDeckError] = useState<string | null>(null);
  useEffect(() => {
    void listSets()
      .then(setSets)
      .catch(() => {});
  }, [catalogCount]);
  useEffect(() => {
    let active = true;
    void listDecks()
      .then((decks) => {
        if (active) {
          setRecentDecks(decks.slice(0, 3));
          setDeckError(null);
        }
      })
      .catch((error: unknown) => {
        if (active) setDeckError(String(error));
      });
    return () => {
      active = false;
    };
  }, [revision]);

  const currentWeek = Math.max(0, (league.week || 1) - 1);
  const upcoming =
    league.upcomingExpansions ??
    settings.league.expansionSchedule.filter(
      (entry) => entry.week > currentWeek,
    );
  const nextExpansion =
    league.nextExpansion === undefined ? upcoming[0] : league.nextExpansion;
  const expansionName = (code: string) =>
    settings.league.expansionSchedule.find(
      (entry) => entry.code.toLowerCase() === code.toLowerCase(),
    )?.name ??
    sets.find((set) => set.code.toLowerCase() === code.toLowerCase())?.name ??
    code.toUpperCase();
  const metrics = [
    { label: "Cards owned", value: stats.totalCards, icon: Layers3 },
    { label: "Saved decks", value: stats.decks, icon: Swords },
    { label: "Wildcards", value: stats.wildcards, icon: Sparkles },
  ];

  return (
    <div className="dashboard-page">
      <section className="hero panel">
        <div className="hero-content">
          <h2>
            Every great deck
            <br />
            starts somewhere.
          </h2>
          <p>
            {catalogCount
              ? "Find your cards, shape your deck, and take it to Forge."
              : "Your card catalog is being prepared automatically."}
          </p>
          <div className="hero-actions">
            <Button onClick={onBoosters} disabled={!catalogCount}>
              {catalogCount
                ? league.started
                  ? `Open boosters · ${league.availablePacks} available`
                  : "Begin your league"
                : "Preparing card catalog..."}
              <ArrowRight size={16} />
            </Button>
            <Button variant="ghost" onClick={onDecks}>
              <Swords size={15} /> Build a deck
            </Button>
          </div>
        </div>
        <div
          className="hero-art hero-art-upright"
          aria-label="Black Lotus banner artwork"
        >
          <div className="orbit orbit-one" />
          <div className="orbit orbit-two" />
          <span className="art-spark art-spark-one">✧</span>
          <span className="art-spark art-spark-two">✧</span>
          <div className="card-shadow card-shadow-back" aria-hidden="true" />
          <div className="card-shadow card-shadow-front" aria-hidden="true" />
          <div className="hero-card hero-banner-card">
            {bannerCard ? (
              <CardImage
                card={bannerCard}
                imageCacheDir={settings.forge.imageCacheDir}
              />
            ) : (
              <div className="card-back">
                <div className="card-back-mark">
                  <Layers3 size={44} strokeWidth={1} />
                  <span>Black Lotus</span>
                </div>
              </div>
            )}
          </div>
          <span className="art-caption">BLACK LOTUS</span>
        </div>
      </section>
      <section
        className="metrics-grid metrics-grid-three"
        aria-label="Collection statistics"
      >
        {metrics.map(({ label, value, icon: Icon }) => (
          <div className="metric panel" key={label}>
            <div className="metric-top">
              <span>{label}</span>
              <Icon size={17} />
            </div>
            <strong>{value.toLocaleString()}</strong>
          </div>
        ))}
      </section>
      <section className="league-status-strip panel">
        <div>
          <span>
            {league.started ? `League week ${currentWeek}` : "Starting packs"}
          </span>
          <strong>
            {league.started
              ? `${league.availablePacks} booster ${league.availablePacks === 1 ? "pack" : "packs"} available`
              : `${league.joinPacks ?? settings.league.startingPacks} packs available when you join`}
          </strong>
        </div>
        <div>
          <span>Unlocked expansions</span>
          <strong className="expansion-names">
            {league.enabledSets.length
              ? league.enabledSets.map(expansionName).join(", ")
              : "No expansions unlocked"}
          </strong>
        </div>
        <div>
          <span>Next weekly reward</span>
          <strong>
            {!league.started
              ? "Begin a league first"
              : league.canClaimWeekly
                ? "Ready to claim"
                : league.nextRewardAt
                  ? new Date(league.nextRewardAt).toLocaleString()
                  : "Not scheduled"}
          </strong>
        </div>
        <Button size="sm" variant="outline" onClick={onBoosters}>
          {league.canClaimWeekly
            ? "Claim reward"
            : league.started
              ? "Open packs"
              : "Begin league"}
          <ArrowRight size={13} />
        </Button>
      </section>
      {nextExpansion ? (
        <section
          className="panel next-expansion"
          aria-label="Next expansion unlock"
        >
          <CalendarDays size={22} />
          <div>
            <span>Next expansion</span>
            <strong>{nextExpansion.name}</strong>
            <p>
              Week {nextExpansion.week} -{" "}
              {new Date(
                (settings.league.startedAt + nextExpansion.week * 604800) *
                  1000,
              ).toLocaleString()}
            </p>
          </div>
          <div className="next-expansion-bonus">
            <strong>+{nextExpansion.bonusPacks} packs</strong>
            <span>Reserved for {nextExpansion.name}</span>
          </div>
        </section>
      ) : settings.league.expansionSchedule.length > 0 &&
        upcoming.length === 0 ? (
        <div
          className="notice notice-info expansion-schedule-alert"
          role="alert"
        >
          <TriangleAlert size={20} />
          <span>
            <strong>No upcoming expansion is scheduled.</strong> All expansions
            on the shared calendar have unlocked.
          </span>
        </div>
      ) : null}
      <div className="dashboard-columns">
        <section className="panel">
          <div className="panel-header">
            <h2 className="section-title">Recent decks</h2>
            <Button variant="ghost" size="sm" onClick={onDecks}>
              Deck builder <ArrowRight size={13} />
            </Button>
          </div>
          <div className="recent-decks">
            {deckError ? (
              <p role="alert">{deckError}</p>
            ) : recentDecks.length ? (
              recentDecks.map((deck) => (
                <div className="recent-deck-row" key={deck.id}>
                  <Swords size={17} />
                  <div>
                    <strong>{deck.name}</strong>
                    <span>
                      {deck.mainCount} main · {deck.sideboardCount} sideboard
                    </span>
                  </div>
                  <small>
                    {new Date(
                      deck.updatedAt.endsWith("Z")
                        ? deck.updatedAt
                        : `${deck.updatedAt.replace(" ", "T")}Z`,
                    ).toLocaleDateString()}
                  </small>
                </div>
              ))
            ) : (
              <div className="recent-decks-empty">
                <p>No saved decks yet.</p>
                <Button variant="outline" size="sm" onClick={onDecks}>
                  Build a deck <ArrowRight size={13} />
                </Button>
              </div>
            )}
          </div>
        </section>
        <section className="panel">
          <div className="panel-header">
            <h2 className="section-title">Wildcards</h2>
          </div>
          <div className="panel-body settings-stack">
            <div className="wildcard-balances">
              {(["common", "uncommon", "rare", "mythic"] as const).map(
                (rarity) => (
                  <span
                    className={`wildcard-balance wildcard-balance-${rarity}`}
                    key={rarity}
                  >
                    <Sparkles size={14} /> {league.wildcards[rarity]} {rarity}
                  </span>
                ),
              )}
            </div>
            <Button variant="outline" onClick={onCollection}>
              Browse and craft <ArrowRight size={13} />
            </Button>
          </div>
        </section>
      </div>
    </div>
  );
}
