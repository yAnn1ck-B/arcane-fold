import { useEffect, useState } from "react";
import {
  ArrowRight,
  CalendarDays,
  ChevronDown,
  Layers3,
  Sparkles,
  Swords,
  TriangleAlert,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { listDecks } from "@/services/decks";
import CardImage from "@/components/CardImage";
import { wildcardHint } from "@/components/WildcardCounters";
import { getBannerMoxes, listSets } from "@/services/cards";
import "@/styles/dashboard-art.css";
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

const bannerMoxes = [
  { name: "Mox Pearl", position: "pearl" },
  { name: "Mox Sapphire", position: "sapphire" },
  { name: "Mox Jet", position: "jet" },
  { name: "Mox Ruby", position: "ruby" },
  { name: "Mox Emerald", position: "emerald" },
];

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
  const [moxCards, setMoxCards] = useState<CatalogCard[]>([]);
  useEffect(() => {
    void listSets()
      .then(setSets)
      .catch(() => {});
  }, [catalogCount]);
  useEffect(() => {
    if (!catalogCount) return;
    let active = true;
    void getBannerMoxes()
      .then((cards) => {
        if (active) setMoxCards(cards);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
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
  const availablePacks =
    league.openablePacks ??
    (league.started
      ? league.availablePacks
      : (league.joinPacks ?? settings.league.startingPacks));
  const nextWeeklyReward = league.nextRewardAt
    ? new Date(league.nextRewardAt)
    : new Date((settings.league.startedAt + (currentWeek + 1) * 604800) * 1000);
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
  const latestUnlocked = [...settings.league.expansionSchedule]
    .reverse()
    .find((entry) => league.enabledSets.some((code) => code.toLowerCase() === entry.code.toLowerCase()));
  const latestUnlockedName = latestUnlocked?.name ?? (league.enabledSets[0] ? expansionName(league.enabledSets[0]) : "");
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
              ? "Open packs, build a deck, and play with a friend."
              : "Your card catalog is being prepared automatically."}
          </p>
          <div className="hero-actions">
            <Button onClick={onBoosters} disabled={!catalogCount}>
              {catalogCount
                ? `Open boosters - ${availablePacks} available`
                : "Preparing card catalog..."}
              <ArrowRight size={16} />
            </Button>
            <Button variant="ghost" onClick={onDecks}>
              <Swords size={15} /> Build a deck
            </Button>
          </div>
        </div>
        <div
          className="hero-art hero-art-upright hero-art-mox"
          aria-label="Black Lotus with Mox Pearl, Mox Sapphire, Mox Jet, Mox Ruby, and Mox Emerald"
        >
          <div className="orbit orbit-one" />
          <div className="orbit orbit-two" />
          <span className="banner-spark banner-spark-left" aria-hidden="true">✧</span>
          <span className="banner-spark banner-spark-right" aria-hidden="true">✧</span>
          {bannerMoxes.map(({ name, position }) => {
            const card = moxCards.find((candidate) => candidate.name === name);
            return (
              <div className={`banner-mox banner-mox-${position}`} key={name}>
                {card ? (
                  <CardImage
                    card={card}
                  />
                ) : (
                  <div className="banner-mox-placeholder">{name}</div>
                )}
              </div>
            );
          })}
          <div className="hero-card hero-banner-card">
            {bannerCard ? (
              <CardImage
                card={bannerCard}
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
          <span>Booster packs</span>
          <strong>{availablePacks} available</strong>
        </div>
        <div className="dashboard-unlocked-expansions">
          <span>Unlocked expansions</span>
          {league.enabledSets.length ? (
            <details
              className="dashboard-expansion-disclosure"
              onKeyDown={(event) => {
                if (event.key === "Escape") event.currentTarget.open = false;
              }}
            >
              <summary
                aria-label={`View ${league.enabledSets.length} unlocked expansions`}
                data-hint={latestUnlockedName}
              >
                <strong>{latestUnlockedName}</strong>
                {league.enabledSets.length > 1 && <span className="dashboard-expansion-more">+{league.enabledSets.length - 1}</span>}
                <ChevronDown size={14} aria-hidden="true" />
              </summary>
              <ul
                className="dashboard-expansion-list"
                aria-label="Unlocked expansion names"
              >
                {league.enabledSets.map((code) => (
                  <li key={code}>{expansionName(code)}</li>
                ))}
              </ul>
            </details>
          ) : (
            <strong>No expansions unlocked</strong>
          )}
        </div>
        <div>
          <span>Next weekly reward</span>
          <strong>{nextWeeklyReward.toLocaleString()}</strong>
        </div>
        <Button size="sm" variant="outline" onClick={onBoosters}>
          Open boosters
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
              {(["common", "uncommon", "rare", "mythic", "discovery"] as const).map((kind) => {
                const count = league.wildcards[kind] ?? 0;
                const hint = wildcardHint(kind, count);
                return (
                  <span
                    className={`wildcard-balance wildcard-balance-${kind}`}
                    key={kind}
                    data-hint={hint}
                    role="img"
                    tabIndex={0}
                    aria-label={hint}
                  >
                    <i
                      className={`rarity-dot rarity-${kind}`}
                      aria-hidden="true"
                    />
                    <strong className="dashboard-wildcard-count">
                      {count}
                    </strong>
                    <span className="dashboard-wildcard-label">{kind === "discovery" ? "Discovery" : kind}</span>
                  </span>
                );
              })}
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
