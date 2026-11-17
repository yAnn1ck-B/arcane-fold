import { useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  History,
  Layers3,
  Loader2,
  Package,
  Sparkles,
  X,
} from "lucide-react";
import CardImage from "@/components/CardImage";
import CardDetails from "@/components/CardDetails";
import WildcardCounters from "@/components/WildcardCounters";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ToastProvider";
import {
  leagueStatus,
  openBoosters,
  openNextBoosters,
  resolveBoosterOpening,
} from "@/services/progression";
import "@/styles/booster-page.css";
import type {
  AppSettings,
  BoosterHistory,
  BoosterOpening,
  CatalogCard,
  LeagueStatus,
  WildcardBalances,
} from "@/lib/types";

interface BoostersProps {
  settings: AppSettings;
  revision: number;
  onChange: () => void;
  league: LeagueStatus;
  active?: boolean;
}
interface OpeningAttempt {
  requestId: string;
  count: number;
  setCode?: string;
}
type Notice = {
  kind: "error" | "info";
  message: string;
  source: "status" | "opening";
};
const attemptKey = "eternal-league.pending-booster-opening";
const rarities = ["common", "uncommon", "rare", "mythic"] as const;
function loadAttempt(): OpeningAttempt | null {
  try {
    const value = JSON.parse(
      localStorage.getItem(attemptKey) ?? "null",
    ) as Partial<OpeningAttempt> | null;
    if (
      !value ||
      typeof value.requestId !== "string" ||
      !/^[a-z0-9-]{16,100}$/i.test(value.requestId) ||
      !Number.isSafeInteger(value.count) ||
      Number(value.count) < 0 ||
      Number(value.count) > 10000 ||
      (value.setCode !== undefined &&
        (typeof value.setCode !== "string" ||
          !/^[a-z0-9]+$/i.test(value.setCode)))
    )
      return null;
    return value as OpeningAttempt;
  } catch {
    return null;
  }
}
function storeAttempt(attempt: OpeningAttempt | null) {
  try {
    if (attempt) localStorage.setItem(attemptKey, JSON.stringify(attempt));
    else localStorage.removeItem(attemptKey);
  } catch {
    /* Keep the in-memory receipt if storage is unavailable. */
  }
}
function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
function formatDate(value: string | null) {
  return value ? new Date(value).toLocaleString() : "";
}
function wildcardTotal(values?: WildcardBalances) {
  return rarities.reduce((n, rarity) => n + (values?.[rarity] ?? 0), 0);
}
function openingSummary(
  cards: CatalogCard[],
  duplicateWildcards?: WildcardBalances,
) {
  const replacements = wildcardTotal(duplicateWildcards);
  return `${cards.length} ${cards.length === 1 ? "card" : "cards"}${replacements ? ` · ${replacements} ${replacements === 1 ? "wildcard" : "wildcards"}` : ""}`;
}
function expansionName(
  code: string,
  cards: CatalogCard[],
  schedule: AppSettings["league"]["expansionSchedule"],
) {
  const normalized = code.trim().toLowerCase();
  return (
    schedule
      .find((set) => set.code.trim().toLowerCase() === normalized)
      ?.name.trim() ||
    cards
      .find(
        (card) =>
          card.setCode.trim().toLowerCase() === normalized &&
          card.setName.trim(),
      )
      ?.setName.trim() ||
    code.trim().toUpperCase()
  );
}

export default function Boosters({
  settings,
  revision,
  onChange,
  league,
  active = true,
}: BoostersProps) {
  const toast = useToast();
  const [status, setStatus] = useState<LeagueStatus | null>(league);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [attempt, setAttempt] = useState<OpeningAttempt | null>(loadAttempt);
  const [opening, setOpening] = useState<BoosterOpening | null>(null);
  const [selectedCard, setSelectedCard] = useState<CatalogCard | null>(null);
  const [shownCards, setShownCards] = useState(60);
  const [expandedHistory, setExpandedHistory] = useState<string | null>(null);
  const actionRunning = useRef(false);
  const resumedAttempt = useRef<string | null>(null);
  const activePage = useRef(active);
  const contentsVisit = useRef(0);
  activePage.current = active;
  useEffect(() => {
    if (!active) {
      contentsVisit.current += 1;
      setOpening(null);
      setSelectedCard(null);
      setExpandedHistory(null);
      setShownCards(60);
    }
  }, [active]);
  useEffect(() => {
    setStatus(league);
  }, [league]);
  useEffect(() => {
    let active = true;
    leagueStatus()
      .then((next) => {
        if (active) {
          setStatus(next);
          setNotice((current) =>
            current?.source === "status" ? null : current,
          );
        }
      })
      .catch((error) => {
        if (active)
          setNotice({
            kind: "error",
            message: message(error),
            source: "status",
          });
      });
    return () => {
      active = false;
    };
  }, [revision]);
  const performOpening = useCallback(
    async (
      next: OpeningAttempt,
      resolveOnly = false,
      fallbackCount?: number,
    ) => {
      if (actionRunning.current) return;
      const currentVisit = contentsVisit.current;
      actionRunning.current = true;
      setBusy(true);
      setNotice(null);
      setSelectedCard(null);
      setAttempt(next);
      storeAttempt(next);
      try {
        let request = next;
        let result = resolveOnly
          ? await resolveBoosterOpening(
              next.requestId,
              next.count,
              next.setCode,
            )
          : null;
        if (resolveOnly && !result) {
          setAttempt(null);
          storeAttempt(null);
          // Reloading an old Open all must not spend packs earned since then.
          // Only a fresh click can start another opening after settlement.
          if (fallbackCount === undefined) return;
          request = { count: fallbackCount, requestId: crypto.randomUUID() };
          setAttempt(request);
          storeAttempt(request);
        }
        if (!result) {
          const open = () =>
            request.setCode
              ? openBoosters(request.setCode, request.count, request.requestId)
              : openNextBoosters(request.count, request.requestId);
          try {
            result = await open();
          } catch {
            // A lost reply can follow a successful commit. Reuse the exact request
            // so the native receipt returns its result without spending more packs.
            try {
              result = await open();
            } catch (error) {
              try {
                result = await resolveBoosterOpening(
                  request.requestId,
                  request.count,
                  request.setCode,
                );
                if (!result) {
                  setAttempt(null);
                  storeAttempt(null);
                }
              } catch {
                /* Preserve the request while its saved outcome is unknown. */
              }
              if (!result) throw error;
            }
          }
        }
        // A finished opening replaces the previous contents. Results from a
        // visit the user has left remain available in history instead.
        if (activePage.current && contentsVisit.current === currentVisit) {
          setOpening(result);
        }
        setShownCards(60);
        setAttempt(null);
        storeAttempt(null);
        toast(
          result.packs === 1
            ? "Opened one pack."
            : `Opened ${result.packs.toLocaleString()} packs.`,
        );
        onChange();
        try {
          setStatus(await leagueStatus());
        } catch (error) {
          setNotice({
            kind: "info",
            message: `Cards saved. Progress could not refresh: ${message(error)}`,
            source: "status",
          });
        }
      } catch (error) {
        setNotice({
          kind: "error",
          message: message(error),
          source: "opening",
        });
        try {
          setStatus(await leagueStatus());
          onChange();
        } catch {
          /* Retain the same receipt for retry. */
        }
      } finally {
        actionRunning.current = false;
        setBusy(false);
      }
    },
    [onChange, toast],
  );
  useEffect(() => {
    if (!active) {
      resumedAttempt.current = null;
      return;
    }
    if (
      !attempt ||
      actionRunning.current ||
      resumedAttempt.current === attempt.requestId
    )
      return;
    resumedAttempt.current = attempt.requestId;
    void performOpening(attempt, true);
  }, [active, attempt, performOpening]);
  const available =
    status?.openablePacks ??
    (status?.started
      ? status.availablePacks
      : (status?.joinPacks ?? settings.league.startingPacks));
  const canOpen = !!status && !busy && (!!attempt || available > 0);
  function startOpening(count: number) {
    if (!canOpen) return;
    if (attempt) void performOpening(attempt, true, count);
    else void performOpening({ count, requestId: crypto.randomUUID() });
  }
  return (
    <div className="booster-page">
      {notice && (
        <div
          className={`notice notice-${notice.kind}`}
          role={notice.kind === "error" ? "alert" : "status"}
        >
          <span>{notice.message}</span>
          <button
            className="booster-dismiss"
            aria-label="Dismiss booster message"
            onClick={() => setNotice(null)}
          >
            <X size={15} />
          </button>
        </div>
      )}
      {status && (
        <section className="panel booster-summary" aria-label="Booster packs">
          <div className="booster-total">
            <Package size={24} />
            <strong>
              {available.toLocaleString()}{" "}
              <small>{available === 1 ? "pack" : "packs"}</small>
            </strong>
          </div>
          <div className="booster-summary-actions">
            <Button onClick={() => startOpening(1)} disabled={!canOpen}>
              {busy ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <Package size={16} />
              )}{" "}
              Open one pack
            </Button>
            <Button
              variant="outline"
              onClick={() => startOpening(0)}
              disabled={!canOpen}
            >
              <Layers3 size={16} /> Open all
            </Button>
          </div>
          <WildcardCounters
            balances={status.wildcards}
            className="booster-summary-wildcards"
          />
        </section>
      )}
      {status && (
        <>
          {opening && (
            <section
              className="panel booster-opening"
              aria-label="Pack contents"
            >
              <div className="panel-header">
                <div className="booster-opening-heading">
                  <span className="booster-contents-icon" aria-hidden="true">
                    <Sparkles size={22} />
                  </span>
                  <div>
                    <h2 className="section-title">Pack contents</h2>
                    <p className="field-hint">
                      {opening.packs === 1
                        ? "One pack"
                        : `${opening.packs.toLocaleString()} packs`}
                      {" · "}
                      {openingSummary(
                        opening.cards,
                        opening.duplicateWildcards,
                      )}
                    </p>
                  </div>
                </div>
              </div>
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
                      expansion={expansionName(
                        card.setCode,
                        [card],
                        settings.league.expansionSchedule,
                      )}
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

          {status.history.length > 0 && (
            <section className="panel booster-history">
              <div className="panel-header">
                <h2 className="section-title">Opening history</h2>
                <History size={20} className="muted-icon" />
              </div>
              <div className="booster-history-list">
                {status.history.map((item) => (
                  <HistoryRow
                    key={item.id}
                    item={item}
                    expansion={expansionName(
                      item.setCode,
                      item.cards,
                      settings.league.expansionSchedule,
                    )}
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
            </section>
          )}
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
  expansion,
  imageCacheDir,
  onSelect,
}: {
  card: CatalogCard;
  expansion: string;
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
      <span title={`${expansion} #${card.collectorNumber} - ${card.rarity}`}>
        {expansion} #{card.collectorNumber} · {card.rarity}
      </span>
    </article>
  );
}

function HistoryRow({
  item,
  expansion,
  expanded,
  onToggle,
  imageCacheDir,
  onSelectCard,
}: {
  item: BoosterHistory;
  expansion: string;
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
          <strong title={expansion}>{expansion}</strong>
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
                  expansion={
                    card.setCode.trim().toLowerCase() ===
                    item.setCode.trim().toLowerCase()
                      ? expansion
                      : card.setName.trim() || card.setCode.toUpperCase()
                  }
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
