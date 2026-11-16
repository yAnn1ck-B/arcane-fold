import { useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronUp,
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
import {
  leagueStatus,
  openBoosters,
  openNextBoosters,
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
}
interface OpeningAttempt {
  requestId: string;
  count: number;
  setCode?: string;
}
type Notice = { kind: "success" | "error" | "info"; message: string };
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
export default function Boosters({
  settings,
  revision,
  onChange,
  league,
}: BoostersProps) {
  const [status, setStatus] = useState<LeagueStatus | null>(league);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [attempt, setAttempt] = useState<OpeningAttempt | null>(loadAttempt);
  const [opening, setOpening] = useState<BoosterOpening | null>(null);
  const [selectedCard, setSelectedCard] = useState<CatalogCard | null>(null);
  const [shownCards, setShownCards] = useState(60);
  const [expandedHistory, setExpandedHistory] = useState<string | null>(null);
  const actionRunning = useRef(false);
  const openingPanel = useRef<HTMLElement>(null);
  useEffect(() => {
    setStatus(league);
  }, [league]);
  useEffect(() => {
    let active = true;
    leagueStatus()
      .then((next) => {
        if (active) setStatus(next);
      })
      .catch((error) => {
        if (active) setNotice({ kind: "error", message: message(error) });
      });
    return () => {
      active = false;
    };
  }, [revision]);
  useEffect(() => {
    if (opening)
      openingPanel.current?.scrollIntoView({
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "instant"
          : "smooth",
        block: "start",
      });
  }, [opening?.id]);
  async function performOpening(next: OpeningAttempt) {
    if (actionRunning.current || opening) return;
    actionRunning.current = true;
    setBusy(true);
    setNotice(null);
    setAttempt(next);
    storeAttempt(next);
    try {
      const result = next.setCode
        ? await openBoosters(next.setCode, next.count, next.requestId)
        : await openNextBoosters(next.count, next.requestId);
      setOpening(result);
      setShownCards(60);
      setAttempt(null);
      storeAttempt(null);
      onChange();
      try {
        setStatus(await leagueStatus());
      } catch (error) {
        setNotice({
          kind: "info",
          message: `Cards saved. Progress could not refresh: ${message(error)}`,
        });
      }
    } catch (error) {
      setNotice({ kind: "error", message: message(error) });
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
  }
  const available =
    status?.openablePacks ??
    (status?.started
      ? status.availablePacks
      : (status?.joinPacks ?? settings.league.startingPacks));
  const canOpen = !!status && available > 0 && !busy && !attempt && !opening;
  function startOpening(count: number) {
    if (canOpen) void performOpening({ count, requestId: crypto.randomUUID() });
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
      {attempt && (
        <section
          className="notice booster-recovery"
          aria-label="Recover booster opening"
        >
          <span>Opening interrupted.</span>
          <Button
            size="sm"
            onClick={() => void performOpening(attempt)}
            disabled={busy || !!opening}
          >
            <RefreshCw size={14} />
            Retry opening
          </Button>
        </section>
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
          <div className="booster-summary-wildcards" aria-label="Wildcards">
            {rarities.map((rarity) => (
              <span
                key={rarity}
                title={`${status.wildcards[rarity]} ${rarity} wildcards`}
              >
                <i className={`rarity-dot rarity-${rarity}`} />
                <strong>{status.wildcards[rarity]}</strong> {rarity}
              </span>
            ))}
          </div>
        </section>
      )}
      {status && (
        <>
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
