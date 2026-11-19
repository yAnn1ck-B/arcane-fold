import { useEffect, useState, type KeyboardEvent } from "react";
import { CalendarDays, Sparkles } from "lucide-react";
import "@/styles/dashboard-art.css";
import { listSets } from "@/services/cards";
import type { AppSettings, CatalogSet, LeagueStatus } from "@/lib/types";

interface LeagueGuideProps {
  settings: AppSettings;
  catalogCount: number;
  leagueStatus: LeagueStatus;
}

const tabs = [
  { id: "league", label: "League rules", Icon: Sparkles },
  { id: "calendar", label: "Expansion calendar", Icon: CalendarDays },
] as const;
type GuideTab = (typeof tabs)[number]["id"];

export default function LeagueGuide({ settings, catalogCount, leagueStatus }: LeagueGuideProps) {
  const [tab, setTab] = useState<GuideTab>("league");
  const [sets, setSets] = useState<CatalogSet[]>([]);
  useEffect(() => {
    let active = true;
    void listSets().then((result) => { if (active) setSets(result); }).catch(() => {});
    return () => { active = false; };
  }, [catalogCount]);

  function navigateTabs(
    event: KeyboardEvent<HTMLButtonElement>,
    current: GuideTab,
  ) {
    const index = tabs.findIndex(({ id }) => id === current);
    const nextIndex =
      event.key === "ArrowRight"
        ? (index + 1) % tabs.length
        : event.key === "ArrowLeft"
          ? (index + tabs.length - 1) % tabs.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? tabs.length - 1
              : null;
    if (nextIndex === null) return;
    event.preventDefault();
    const nextTab = tabs[nextIndex].id;
    setTab(nextTab);
    document.getElementById(`settings-tab-${nextTab}`)?.focus();
  }
  const expansionName = (code: string) =>
    settings.league.expansionSchedule.find(
      (entry) => entry.code.toLowerCase() === code.toLowerCase(),
    )?.name ??
    sets.find((set) => set.code.toLowerCase() === code.toLowerCase())?.name ??
    code.toUpperCase();
  const league = settings.league;
  const startingAt = league.startedAt;
  const calendar = [...league.expansionSchedule].sort(
    (a, b) => a.week - b.week,
  );
  const currentWeek = Math.max(0, (leagueStatus.week || 1) - 1);
  const unlockedCount = calendar.filter(
    (entry) => entry.week <= currentWeek,
  ).length;
  const currentExpansion = calendar[unlockedCount - 1];
  const nextExpansion = calendar[unlockedCount];
  const composition = [
    [league.booster.commons, "commons"],
    [league.booster.uncommons, "uncommons"],
    [league.booster.rareSlots, "rare or mythic"],
  ]
    .filter(([quantity]) => Number(quantity) > 0)
    .map(([quantity, label]) => `${quantity} ${label}`)
    .join(" · ");
  return (
    <div className="settings-page">
      <div
        className="settings-tabs"
        role="tablist"
        aria-label="League guide sections"
      >
        {tabs.map(
          ({ id, label, Icon }) => (
            <button
              key={id}
              id={`settings-tab-${id}`}
              type="button"
              role="tab"
              aria-controls={`settings-panel-${id}`}
              aria-selected={tab === id}
              tabIndex={tab === id ? 0 : -1}
              className={`settings-tab ${tab === id ? "active" : ""}`}
              onClick={() => setTab(id)}
              onKeyDown={(event) => navigateTabs(event, id)}
            >
              <Icon size={16} /> {label}
            </button>
          ),
        )}
      </div>
      <section
        id="settings-panel-league"
        role="tabpanel"
        aria-labelledby="settings-tab-league"
        className="panel"
        hidden={tab !== "league"}
      >
        <div className="panel-body settings-stack">
          <dl className="league-rule-summary">
            {startingAt != null && (
              <div>
                <dt>League began</dt>
                <dd>{new Date(startingAt * 1000).toLocaleString()}</dd>
              </div>
            )}
            <div>
              <dt>Starting packs</dt>
              <dd>{league.startingPacks}</dd>
            </div>
            <div>
              <dt>Starting wildcards</dt>
              <dd>
                {(["common", "uncommon", "rare", "mythic", "discovery"] as const)
                  .map((kind) => `${league.startingWildcards?.[kind] ?? 0} ${kind === "discovery" ? "Discovery" : kind}`)
                  .join("; ")}
              </dd>
            </div>
            <div>
              <dt>Weekly packs</dt>
              <dd>{league.weeklyPacks}</dd>
            </div>
            <div>
              <dt>Wildcard rewards</dt>
              <dd>
                {(["common", "uncommon", "rare", "mythic", "discovery"] as const)
                  .map((kind) => {
                    const interval =
                      league.wildcardRewardIntervals?.[kind] ?? 1;
                    const offset = league.wildcardRewardOffsets?.[kind] ?? 0;
                    const firstWeek = interval - offset;
                    return `${league.weeklyWildcards[kind] ?? 0} ${kind === "discovery" ? "Discovery" : kind} ${interval === 1 ? "each week" : `every ${interval} weeks, first at week ${firstWeek}`}`;
                  })
                  .join("; ")}
              </dd>
            </div>
            <div>
              <dt>Crafting</dt>
              <dd>
                Matching-rarity wildcards add copies of owned cards. A Discovery
                wildcard acquires the first copy of any eligible card from an
                unlocked expansion.
              </dd>
            </div>
            <div>
              <dt>Pack contents</dt>
              <dd>{composition}</dd>
            </div>
            {league.booster.commonLandWeight != null && (
              <div>
                <dt>Nonbasic lands</dt>
                <dd>
                  Only common lands are{" "}
                  {league.booster.commonLandWeight === 0.5
                    ? "half as likely"
                    : `${Math.round(league.booster.commonLandWeight * 100)}% as likely`}{" "}
                  to be chosen as other commons. Normally at most{" "}
                  {league.booster.preferredLandLimit} land per pack, with
                  mythic, rare, then uncommon lands taking priority over common
                  lands. This limit relaxes when only missing lands remain at a
                  rarity.
                </dd>
              </div>
            )}
            <div>
              <dt>Basic lands</dt>
              <dd>Free from unlocked expansions; never included in packs.</dd>
            </div>
            <div>
              <dt>Mythic chance</dt>
              <dd>
                {Number((league.mythicProbability * 100).toFixed(2))}% of rare
                slots
              </dd>
            </div>
            <div>
              <dt>Bonus wildcard chance</dt>
              <dd>
                {Number((league.wildcardDropProbability * 100).toFixed(2))}%
              </dd>
            </div>
            <div>
              <dt>Collection limit</dt>
              <dd>4 copies across all printings; basic lands are unlimited</dd>
            </div>
            <div>
              <dt>Main deck</dt>
              <dd>At least {league.deckRestrictions.minimumMainDeck} cards</dd>
            </div>
            <div>
              <dt>Sideboard</dt>
              <dd>Up to {league.deckRestrictions.maximumSideboard} cards</dd>
            </div>
            <div>
              <dt>Deck copies</dt>
              <dd>
                Up to {league.deckRestrictions.normalCopyLimit} of each card,
                with card-specific exceptions; owned copies required
              </dd>
            </div>
            <div>
              <dt>Starting expansions</dt>
              <dd>
                {league.enabledSets.length
                  ? league.enabledSets.map(expansionName).join(", ")
                  : "None"}
              </dd>
            </div>
            <div>
              <dt>Expansion unlock reward</dt>
              <dd>
                8 extra packs reserved for the newly unlocked expansion, in
                addition to weekly rewards.
              </dd>
            </div>
          </dl>
        </div>
      </section>
      <section
        id="settings-panel-calendar"
        role="tabpanel"
        aria-labelledby="settings-tab-calendar"
        className="panel"
        hidden={tab !== "calendar"}
      >
        <div className="panel-body settings-stack">
          <section
            className="expansion-calendar"
            aria-label="Expansion calendar"
          >
            <div className="expansion-calendar-heading">
              <h3>Expansion calendar</h3>
              <span className="calendar-current-week">Week {currentWeek}</span>
            </div>
            <div className="calendar-position">
              <progress
                max={Math.max(calendar.length, 1)}
                value={unlockedCount}
                aria-label={`${unlockedCount} of ${calendar.length} expansions unlocked`}
              />
              <p>
                <strong>
                  {unlockedCount} of {calendar.length} unlocked
                </strong>
                {nextExpansion
                  ? `Next: ${nextExpansion.name} at week ${nextExpansion.week}`
                  : "All scheduled expansions are unlocked"}
              </p>
            </div>
            <table>
              <thead>
                <tr>
                  <th>Week</th>
                  <th>Expansion</th>
                  <th>Theme</th>
                  <th>Extra packs</th>
                </tr>
              </thead>
              <tbody>
                {calendar.map((entry) => (
                  <tr
                    key={entry.code}
                    className={
                      entry.code === currentExpansion?.code
                        ? "calendar-current-row"
                        : ""
                    }
                    aria-current={
                      entry.code === currentExpansion?.code ? "step" : undefined
                    }
                  >
                    <td>
                      <strong>{entry.week}</strong>
                      <small>
                        {new Date(
                          (league.startedAt + entry.week * 604800) * 1000,
                        ).toLocaleDateString()}
                      </small>
                    </td>
                    <td>
                      <span className="calendar-expansion-name">
                        {entry.name}
                      </span>
                      <span
                        className={`calendar-unlock-status ${entry.week <= currentWeek ? "calendar-unlocked" : "calendar-upcoming"}`}
                      >
                        {entry.code === currentExpansion?.code
                          ? "Unlocked - current"
                          : entry.week <= currentWeek
                            ? "Unlocked"
                            : entry.code === nextExpansion?.code
                              ? "Upcoming - next"
                              : "Upcoming"}
                      </span>
                    </td>
                    <td>{entry.description}</td>
                    <td>
                      {entry.bonusPacks ? (
                        <>
                          <strong>+{entry.bonusPacks}</strong>
                          <small>For this expansion</small>
                        </>
                      ) : (
                        "Starting pool"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </div>
      </section>
    </div>
  );
}
