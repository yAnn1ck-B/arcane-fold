import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock3,
  Gift,
  History,
  Layers3,
  Loader2,
  Package,
  RefreshCw,
  Sparkles,
  X,
} from "lucide-react";
import CardImage from "@/components/CardImage";
import CardDetails from "@/components/CardDetails";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { listSets } from "@/services/cards";
import {
  beginLeague,
  claimWeeklyReward,
  leagueStatus,
  openBoosters,
} from "@/services/progression";
import type {
  AppSettings,
  BoosterHistory,
  BoosterOpening,
  CatalogCard,
  CatalogSet,
  LeagueStatus,
  WildcardBalances,
} from "@/lib/types";

interface BoostersProps {
  settings: AppSettings;
  revision: number;
  onChange: () => void;
  league: LeagueStatus;
}
interface OpeningAttempt {
  requestId: string;
  setCode: string;
  count: number;
}
type Notice = { kind: "success" | "error" | "info"; message: string };
const attemptKey = "eternal-league.pending-booster-opening";
const rarities = ["common", "uncommon", "rare", "mythic"] as const;

function loadAttempt(): OpeningAttempt | null {
  try {
    const raw = window.localStorage.getItem(attemptKey);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<OpeningAttempt>;
    if (
      typeof value.requestId !== "string" ||
      !/^[a-z0-9-]{16,100}$/i.test(value.requestId) ||
      typeof value.setCode !== "string" ||
      !/^[a-z0-9]+$/i.test(value.setCode) ||
      !Number.isSafeInteger(value.count) ||
      Number(value.count) < 1 ||
      Number(value.count) > 100
    )
      return null;
    return value as OpeningAttempt;
  } catch {
    return null;
  }
}

function storeAttempt(attempt: OpeningAttempt | null) {
  try {
    if (attempt)
      window.localStorage.setItem(attemptKey, JSON.stringify(attempt));
    else window.localStorage.removeItem(attemptKey);
  } catch {
    /* The in-memory attempt remains usable if browser storage is unavailable. */
  }
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
function formatDate(value: string | null) {
  if (!value) return "Not scheduled";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function wildcardTotal(values?: WildcardBalances) {
  return rarities.reduce((total, rarity) => total + (values?.[rarity] ?? 0), 0);
}

function openingSummary(
  cards: CatalogCard[],
  duplicateWildcards?: WildcardBalances,
) {
  const replacements = wildcardTotal(duplicateWildcards);
  const cardSummary = `${cards.length} ${cards.length === 1 ? "card" : "cards"}`;
  return replacements
    ? `${cardSummary} · ${replacements} duplicate-protection ${replacements === 1 ? "wildcard" : "wildcards"}`
    : cardSummary;
}

export default function Boosters({
  settings,
  revision,
  onChange,
  league,
}: BoostersProps) {
  const [status, setStatus] = useState<LeagueStatus | null>(null);
  const [sets, setSets] = useState<CatalogSet[]>([]);
  const [setCode, setSetCode] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [attempt, setAttempt] = useState<OpeningAttempt | null>(loadAttempt);
  const [attemptStatusChecked, setAttemptStatusChecked] = useState(false);
  const [opening, setOpening] = useState<BoosterOpening | null>(null);
  const [selectedCard, setSelectedCard] = useState<CatalogCard | null>(null);
  const [shownCards, setShownCards] = useState(60);
  const [expandedHistory, setExpandedHistory] = useState<string | null>(null);
  const actionRunning = useRef(false);
  const openingPanel = useRef<HTMLElement>(null);
  const enabledSets = sets.filter((set) =>
    status?.enabledSets.some(
      (code) => code.toLowerCase() === set.code.toLowerCase(),
    ),
  );
  const selectedSet = sets.find(
    (set) => set.code.toLowerCase() === setCode.toLowerCase(),
  );
  const openingActive = !!opening;

  useEffect(() => {
    if (opening && !loading)
      openingPanel.current?.scrollIntoView({
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "instant"
          : "smooth",
        block: "start",
      });
  }, [opening?.id, loading]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    Promise.all([leagueStatus(), listSets()])
      .then(([next, catalogSets]) => {
        if (!active) return;
        setStatus(next);
        setSets(catalogSets);
        setAttemptStatusChecked(true);
        setSetCode((current) =>
          next.enabledSets.some(
            (code) => code.toLowerCase() === current.toLowerCase(),
          ) &&
          catalogSets.some(
            (set) => set.code.toLowerCase() === current.toLowerCase(),
          )
            ? current
            : (catalogSets.find((set) =>
                next.enabledSets.some(
                  (code) => code.toLowerCase() === set.code.toLowerCase(),
                ),
              )?.code ?? ""),
        );
      })
      .catch((error: unknown) => {
        if (active)
          setNotice({
            kind: "error",
            message: `Could not load league progress: ${message(error)}`,
          });
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [revision]);

  useEffect(() => {
    setStatus(league);
  }, [league]);

  useEffect(() => {
    setSetCode((current) =>
      enabledSets.some((set) => set.code === current)
        ? current
        : (enabledSets[0]?.code ?? ""),
    );
  }, [status?.enabledSets, sets]);

  async function refresh() {
    if (actionRunning.current) return;
    actionRunning.current = true;
    setBusy("refresh");
    try {
      const [next, catalogSets] = await Promise.all([
        leagueStatus(),
        listSets(),
      ]);
      setStatus(next);
      setSets(catalogSets);
      setAttemptStatusChecked(true);
      setNotice({
        kind: "info",
        message: "League progress refreshed from your local database.",
      });
    } catch (error) {
      setAttemptStatusChecked(false);
      setNotice({ kind: "error", message: message(error) });
    } finally {
      actionRunning.current = false;
      setBusy(null);
    }
  }

  async function reward(kind: "begin" | "weekly") {
    if (actionRunning.current || attempt || openingActive) return;
    actionRunning.current = true;
    setBusy(kind);
    setNotice(null);
    try {
      const next =
        kind === "begin" ? await beginLeague() : await claimWeeklyReward();
      setStatus(next);
      onChange();
      setNotice({
        kind: "success",
        message:
          kind === "begin"
            ? "You have joined the league. Your starting and catch-up rewards are ready."
            : "Weekly rewards claimed and saved to your league.",
      });
    } catch (error) {
      setNotice({ kind: "error", message: message(error) });
    } finally {
      actionRunning.current = false;
      setBusy(null);
    }
  }

  async function performOpening(nextAttempt: OpeningAttempt) {
    if (actionRunning.current || openingActive) return;
    actionRunning.current = true;
    setBusy("open");
    setNotice(null);
    setAttemptStatusChecked(false);
    setAttempt(nextAttempt);
    storeAttempt(nextAttempt);
    try {
      const result = await openBoosters(
        nextAttempt.setCode,
        nextAttempt.count,
        nextAttempt.requestId,
      );
      setOpening(result);
      setShownCards(60);
      setAttempt(null);
      storeAttempt(null);
      onChange();
      try {
        setStatus(await leagueStatus());
        setAttemptStatusChecked(true);
      } catch (error) {
        setNotice({
          kind: "info",
          message: `Your cards are saved. Progress refresh failed: ${message(error)}`,
        });
      }
    } catch (error) {
      let saved = false;
      try {
        const next = await leagueStatus();
        setStatus(next);
        setAttemptStatusChecked(true);
        onChange();
        saved = next.history.some(
          (item) =>
            item.id === nextAttempt.requestId ||
            item.id.startsWith(`${nextAttempt.requestId}:`),
        );
      } catch {
        setAttemptStatusChecked(false);
      }
      setNotice({
        kind: "error",
        message: saved
          ? `This opening is already saved in your history. Retry the same attempt to recover its results. ${message(error)}`
          : `${message(error)} Retry this attempt to avoid spending the same packs twice.`,
      });
    } finally {
      actionRunning.current = false;
      setBusy(null);
    }
  }

  function startOpening(count: number) {
    if (
      !setCode ||
      !status ||
      attempt ||
      actionRunning.current ||
      openingActive
    )
      return;
    void performOpening({
      requestId: crypto.randomUUID(),
      setCode,
      count,
    });
  }

  function dismissAttempt() {
    if (busy || !attemptStatusChecked) return;
    setAttempt(null);
    storeAttempt(null);
    setNotice({
      kind: "info",
      message:
        "Failed attempt dismissed. Any completed opening is saved in history, and the pack balance shown here is current.",
    });
  }

  const expansionName = (code: string) =>
    settings.league.expansionSchedule.find(
      (entry) => entry.code.toLowerCase() === code.toLowerCase(),
    )?.name ??
    sets.find((set) => set.code.toLowerCase() === code.toLowerCase())?.name ??
    code.toUpperCase();
  const generalPacks = status?.generalPacks ?? status?.availablePacks ?? 0;
  const selectedSetPacks = status?.setPacks?.[setCode.toLowerCase()] ?? 0;
  const selectedAvailablePacks = generalPacks + selectedSetPacks;
  const reservedPacks = Object.entries(status?.setPacks ?? {}).filter(
    ([, count]) => count > 0,
  );
  const canOpen =
    !!status?.started &&
    selectedAvailablePacks > 0 &&
    !!setCode &&
    enabledSets.some((set) => set.code === setCode) &&
    !busy &&
    !attempt &&
    !openingActive;
  const allCount = Math.min(selectedAvailablePacks, 100);
  const joinPacks = status?.joinPacks ?? settings.league.startingPacks;
  const joinWildcards = status?.joinWildcards;
  const rewardPacks = status?.canClaimWeekly
    ? (status.claimablePacks ?? settings.league.weeklyPacks)
    : settings.league.weeklyPacks;
  const rewardWildcards = status?.canClaimWeekly
    ? (status.claimableWildcards ?? settings.league.weeklyWildcards)
    : settings.league.weeklyWildcards;

  return (
    <div className="booster-page">
      {notice && (
        <div
          className={`notice notice-${notice.kind}`}
          role={notice.kind === "error" ? "alert" : "status"}
        >
          <span>{notice.message}</span>
          <button
            type="button"
            className="booster-dismiss"
            aria-label="Dismiss booster message"
            onClick={() => setNotice(null)}
          >
            <X size={15} />
          </button>
        </div>
      )}
      {attempt && (
        <section
          className="notice notice-info booster-recovery"
          aria-label="Recover a previous booster opening"
        >
          <div>
            <strong>An opening needs your attention.</strong>
            <p>
              {attempt.count} {attempt.count === 1 ? "pack" : "packs"} from{" "}
              {attempt.setCode.toUpperCase()}. Retrying uses the original
              receipt, so a completed opening cannot be claimed twice.
            </p>
          </div>
          <div>
            <Button
              size="sm"
              onClick={() => void performOpening(attempt)}
              disabled={!!busy || openingActive}
            >
              {busy === "open" ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <RefreshCw size={14} />
              )}{" "}
              Retry same opening
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={dismissAttempt}
              disabled={!!busy || !attemptStatusChecked}
            >
              Dismiss failed attempt
            </Button>
            {!attemptStatusChecked && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void refresh()}
                disabled={!!busy}
              >
                Check saved progress
              </Button>
            )}
          </div>
        </section>
      )}
      {loading && !status ? (
        <div className="loading-state" role="status">
          <Loader2 size={25} className="animate-spin" />
          <p>Opening your league journal…</p>
        </div>
      ) : !status ? (
        <section className="panel booster-empty">
          <Package size={34} />
          <h2>Your league could not be loaded.</h2>
          <Button
            variant="outline"
            onClick={() => void refresh()}
            disabled={!!busy}
          >
            Try again
          </Button>
        </section>
      ) : (
        <>
          <section className="booster-balances" aria-label="League rewards">
            <div className="panel booster-pack-balance">
              <Package size={25} strokeWidth={1.4} />
              <div>
                <span className="eyebrow">Available packs</span>
                <strong>
                  {status.availablePacks.toLocaleString()}{" "}
                  <small>
                    {status.availablePacks === 1
                      ? "booster pack"
                      : "booster packs"}
                  </small>
                </strong>
                <p className="pack-balance-breakdown">
                  {generalPacks} general packs
                </p>
                {reservedPacks.length > 0 && (
                  <div className="reserved-pack-balances">
                    {reservedPacks.map(([code, count]) => (
                      <button
                        type="button"
                        key={code}
                        onClick={() => setSetCode(code.toLowerCase())}
                        disabled={!!busy || !!attempt || openingActive}
                      >
                        <strong>{count}</strong> {expansionName(code)} only
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
            <div className="panel booster-wildcard-balances">
              <span className="eyebrow">Wildcards</span>
              <div>
                {rarities.map((rarity) => (
                  <div
                    className={`booster-wildcard booster-wildcard-${rarity}`}
                    key={rarity}
                  >
                    <Sparkles size={17} />
                    <strong>{status.wildcards[rarity].toLocaleString()}</strong>
                    <span>{rarity}</span>
                  </div>
                ))}
              </div>
            </div>
          </section>

          {!status.started ? (
            <section className="panel booster-start">
              <div className="booster-pack-illustration" aria-hidden="true">
                <Sparkles size={30} strokeWidth={1.2} />
                <span>
                  ETERNAL
                  <br />
                  LEAGUE
                </span>
                <small>THE FIRST CHAPTER</small>
              </div>
              <div>
                <h2>Start your league</h2>
                <p>
                  Receive {joinPacks} booster packs, including all rewards
                  earned since the shared league began.
                </p>
                <p className="field-hint">
                  Weekly reward: {settings.league.weeklyPacks} packs. Missed
                  rewards accumulate automatically and can only be claimed once.
                </p>
                {Object.entries(status.joinSetPacks ?? {}).some(
                  ([, count]) => count > 0,
                ) && (
                  <p className="field-hint">
                    Includes expansion packs:{" "}
                    {Object.entries(status.joinSetPacks ?? {})
                      .filter(([, count]) => count > 0)
                      .map(
                        ([code, count]) =>
                          `${count} for ${expansionName(code)}`,
                      )
                      .join(", ")}
                    . These are reserved for their expansion.
                  </p>
                )}
                {joinWildcards &&
                  rarities.some((rarity) => joinWildcards[rarity] > 0) && (
                    <p className="field-hint">
                      Catch-up wildcards:{" "}
                      {rarities
                        .filter((rarity) => joinWildcards[rarity] > 0)
                        .map((rarity) => `${joinWildcards[rarity]} ${rarity}`)
                        .join(" ? ")}
                    </p>
                  )}
                {!enabledSets.length && (
                  <p className="booster-setup-hint">
                    The shared card catalog is still being prepared. Check your
                    Forge folders if setup cannot finish.
                  </p>
                )}
                <Button
                  onClick={() => void reward("begin")}
                  disabled={!!busy || !!attempt || !enabledSets.length}
                >
                  {busy === "begin" ? (
                    <Loader2 size={16} className="animate-spin" />
                  ) : (
                    <Gift size={16} />
                  )}{" "}
                  Begin your league <ArrowRight size={15} />
                </Button>
              </div>
            </section>
          ) : (
            <div className="booster-main-grid">
              <section className="panel booster-selection">
                <div className="panel-header">
                  <div>
                    <h2 className="section-title">Choose an expansion</h2>
                  </div>
                  <span className="badge badge-muted">
                    Week {Math.max(0, status.week - 1)}
                  </span>
                </div>
                <div className="panel-body">
                  <div className="booster-pack-illustration" aria-hidden="true">
                    <Layers3 size={32} strokeWidth={1.1} />
                    <span>
                      {setCode ? setCode.toUpperCase() : "ETERNAL"}
                      <br />
                      LEAGUE
                    </span>
                    <small>YOUR CARDS · SIMPLIFIED BOOSTER</small>
                  </div>
                  <Label htmlFor="booster-expansion">Enabled expansion</Label>
                  <select
                    id="booster-expansion"
                    value={setCode}
                    onChange={(event) => setSetCode(event.target.value)}
                    disabled={
                      !!busy ||
                      !!attempt ||
                      openingActive ||
                      !enabledSets.length
                    }
                  >
                    {!enabledSets.length && (
                      <option value="">
                        No enabled expansions in the catalog
                      </option>
                    )}
                    {enabledSets.map((set) => (
                      <option key={set.code} value={set.code}>
                        {set.name} ({set.code.toUpperCase()})
                      </option>
                    ))}
                  </select>
                  {selectedSet && (
                    <p className="field-hint">
                      {selectedSet.count.toLocaleString()} catalog printings in{" "}
                      {selectedSet.name}.
                    </p>
                  )}
                  {!enabledSets.length && (
                    <p className="booster-setup-hint">
                      The shared expansion catalog is still being prepared.
                      Existing collected cards remain available.
                    </p>
                  )}
                  <p className="selected-pack-balance">
                    <strong>{selectedAvailablePacks}</strong> packs available
                    for {selectedSet?.name ?? expansionName(setCode)}
                    <span>
                      {generalPacks} general + {selectedSetPacks} expansion
                      packs
                    </span>
                  </p>
                  <div className="booster-open-actions">
                    <Button onClick={() => startOpening(1)} disabled={!canOpen}>
                      {busy === "open" ? (
                        <Loader2 size={16} className="animate-spin" />
                      ) : (
                        <Package size={16} />
                      )}{" "}
                      Open one pack
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => startOpening(allCount)}
                      disabled={!canOpen}
                    >
                      <Layers3 size={15} />{" "}
                      {selectedAvailablePacks > 100
                        ? "Open 100 packs"
                        : "Open all"}{" "}
                    </Button>
                  </div>
                  {selectedAvailablePacks > 100 && (
                    <p className="field-hint">
                      Open all processes up to 100 packs at a time.
                    </p>
                  )}
                  <p className="field-hint">
                    Cards already owned four times are skipped. Completed rarity
                    pools award matching wildcards instead.
                  </p>
                  <p className="booster-saved-note">
                    <CheckCircle2 size={13} /> Cards are saved as soon as a pack
                    opens. Select any card to see its details.
                  </p>
                </div>
              </section>
              <aside className="panel booster-weekly">
                <div className="panel-header">
                  <div>
                    <h2 className="section-title">Weekly rewards</h2>
                  </div>
                  <Clock3 size={20} className="muted-icon" />
                </div>
                <div className="panel-body">
                  <strong className="booster-weekly-count">
                    {rewardPacks}{" "}
                    <small>
                      {rewardPacks === 1 ? "booster pack" : "booster packs"}
                    </small>
                  </strong>
                  <p>
                    {status.canClaimWeekly && (status.claimableWeeks ?? 1) > 1
                      ? `Includes ${status.claimableWeeks} weekly rewards since your last claim.`
                      : "Weekly rewards accumulate from the shared league start."}
                  </p>
                  {status.canClaimWeekly &&
                    Object.entries(status.claimableSetPacks ?? {}).some(
                      ([, count]) => count > 0,
                    ) && (
                      <p className="field-hint">
                        Includes{" "}
                        {Object.entries(status.claimableSetPacks ?? {})
                          .filter(([, count]) => count > 0)
                          .map(
                            ([code, count]) =>
                              `${count} packs reserved for ${expansionName(code)}`,
                          )
                          .join(", ")}{" "}
                        in addition to weekly packs.
                      </p>
                    )}
                  <div className="booster-weekly-wildcards">
                    {rarities.some((rarity) => rewardWildcards[rarity] > 0) ? (
                      rarities
                        .filter((rarity) => rewardWildcards[rarity] > 0)
                        .map((rarity) => (
                          <span key={rarity}>
                            <Sparkles size={12} /> {rewardWildcards[rarity]}{" "}
                            {rarity}
                            {!status.canClaimWeekly && (
                              <small className="wildcard-cadence">
                                {(settings.league.wildcardRewardIntervals?.[
                                  rarity
                                ] ?? 1) === 1
                                  ? "/ week"
                                  : `/ ${settings.league.wildcardRewardIntervals[rarity]} weeks`}
                              </small>
                            )}
                          </span>
                        ))
                    ) : (
                      <span>No weekly wildcards configured.</span>
                    )}
                  </div>
                  <Button
                    variant={status.canClaimWeekly ? "default" : "outline"}
                    onClick={() => void reward("weekly")}
                    disabled={
                      !status.canClaimWeekly ||
                      !!busy ||
                      !!attempt ||
                      openingActive
                    }
                  >
                    {busy === "weekly" ? (
                      <Loader2 size={15} className="animate-spin" />
                    ) : (
                      <Gift size={15} />
                    )}{" "}
                    {status.canClaimWeekly
                      ? `Claim ${status.claimableWeeks && status.claimableWeeks > 1 ? `${status.claimableWeeks} weeks of ` : ""}rewards`
                      : "Next reward not due yet"}
                  </Button>
                  <p className="field-hint">
                    {status.canClaimWeekly
                      ? "Your reward is ready to claim."
                      : `Next reward: ${formatDate(status.nextRewardAt)}`}
                  </p>
                  <p className="field-hint">
                    {status.enabledSets.length}{" "}
                    {status.enabledSets.length === 1
                      ? "expansion"
                      : "expansions"}{" "}
                    unlocked.
                  </p>
                </div>
              </aside>
            </div>
          )}

          {opening && (
            <section
              className="panel booster-opening"
              ref={openingPanel}
              aria-label="Booster opening results"
            >
              <div className="panel-header">
                <div>
                  <h2 className="section-title">
                    {opening.packs === 1
                      ? "Pack contents"
                      : `${opening.packs} opened packs`}
                  </h2>
                  <p className="field-hint">
                    {opening.setCode.toUpperCase()} ·{" "}
                    {openingSummary(opening.cards, opening.duplicateWildcards)}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setOpening(null)}
                >
                  <X size={14} /> Done
                </Button>
              </div>
              <RewardWildcards values={opening.wildcards} />
              <RewardWildcards
                values={opening.duplicateWildcards}
                label="Duplicate protection awarded:"
              />
              {opening.cards.length > 0 && (
                <div className="booster-results-grid">
                  {opening.cards.slice(0, shownCards).map((card, index) => (
                    <RevealedCard
                      key={`${card.id}-${index}`}
                      card={card}
                      imageCacheDir={settings.forge.imageCacheDir}
                      onSelect={() => setSelectedCard(card)}
                    />
                  ))}
                </div>
              )}
              {opening.cards.length > shownCards && (
                <div className="booster-more-results">
                  <Button
                    variant="outline"
                    onClick={() => setShownCards((current) => current + 60)}
                  >
                    Show 60 more cards ({opening.cards.length - shownCards}{" "}
                    remaining)
                  </Button>
                </div>
              )}
            </section>
          )}

          <section className="panel booster-history">
            <div className="panel-header">
              <div>
                <h2 className="section-title">Opening history</h2>
                {status.history.length >= 20 && (
                  <p className="field-hint">
                    Showing the 20 most recent packs. All openings remain saved
                    locally.
                  </p>
                )}
              </div>
              <History size={20} className="muted-icon" />
            </div>
            {!status.history.length ? (
              <div className="booster-history-empty">
                <Package size={27} strokeWidth={1.2} />
                <p>Your first opened pack will be recorded here.</p>
              </div>
            ) : (
              <div className="booster-history-list">
                {status.history.map((item) => (
                  <HistoryRow
                    key={item.id}
                    item={item}
                    expanded={expandedHistory === item.id}
                    onToggle={() =>
                      setExpandedHistory((current) =>
                        current === item.id ? null : item.id,
                      )
                    }
                    imageCacheDir={settings.forge.imageCacheDir}
                    onSelectCard={setSelectedCard}
                  />
                ))}
              </div>
            )}
          </section>
        </>
      )}
      {selectedCard && (
        <CardDetails
          card={selectedCard}
          imageCacheDir={settings.forge.imageCacheDir}
          league={league}
          onClose={() => setSelectedCard(null)}
          onChange={onChange}
        />
      )}
    </div>
  );
}

function RewardWildcards({
  values,
  label = "Wildcards after this opening:",
}: {
  values?: WildcardBalances;
  label?: string;
}) {
  const earned = rarities.filter((rarity) => (values?.[rarity] ?? 0) > 0);
  return earned.length ? (
    <div className="booster-earned-wildcards">
      <Sparkles size={16} />
      <span>{label}</span>
      {earned.map((rarity) => (
        <strong key={rarity}>
          {values?.[rarity]} {rarity}
        </strong>
      ))}
    </div>
  ) : null;
}

function RevealedCard({
  card,
  imageCacheDir,
  onSelect,
}: {
  card: CatalogCard;
  imageCacheDir: string;
  onSelect: () => void;
}) {
  return (
    <article className={`booster-result-card booster-result-${card.rarity}`}>
      <div className="booster-card-art">
        <CardImage card={card} imageCacheDir={imageCacheDir} />
        <button
          type="button"
          className="card-art-trigger"
          onClick={onSelect}
          aria-label={`View ${card.name} details`}
        />
      </div>
      <button type="button" className="booster-card-name" onClick={onSelect}>
        {card.name}
      </button>
      <span>
        {card.setCode.toUpperCase()} #{card.collectorNumber} · {card.rarity}
      </span>
    </article>
  );
}

function HistoryRow({
  item,
  expanded,
  onToggle,
  imageCacheDir,
  onSelectCard,
}: {
  item: BoosterHistory;
  expanded: boolean;
  onToggle: () => void;
  imageCacheDir: string;
  onSelectCard: (card: CatalogCard) => void;
}) {
  const [shown, setShown] = useState(30);
  return (
    <div className="booster-history-item">
      <button
        type="button"
        className="booster-history-toggle"
        onClick={onToggle}
        aria-expanded={expanded}
      >
        <Package size={18} />
        <span>
          <strong>{item.setCode.toUpperCase()}</strong>
          <small>{formatDate(item.openedAt)}</small>
        </span>
        <span>{openingSummary(item.cards, item.duplicateWildcards)}</span>
        {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
      </button>
      {expanded && (
        <>
          <RewardWildcards
            values={item.duplicateWildcards}
            label="Duplicate protection awarded:"
          />
          {item.cards.length > 0 && (
            <div className="booster-results-grid booster-history-cards">
              {item.cards.slice(0, shown).map((card, index) => (
                <RevealedCard
                  key={`${card.id}-${index}`}
                  card={card}
                  imageCacheDir={imageCacheDir}
                  onSelect={() => onSelectCard(card)}
                />
              ))}
            </div>
          )}
          {item.cards.length > shown && (
            <div className="booster-more-results">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShown((current) => current + 30)}
              >
                Show more saved cards
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
