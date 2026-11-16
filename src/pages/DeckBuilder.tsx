import { formatMana } from "@/lib/mana";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Copy,
  Layers3,
  Loader2,
  Minus,
  Plus,
  Save,
  Search,
  Swords,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import CardImage from "@/components/CardImage";
import CardDetails from "@/components/CardDetails";
import { isUnlimitedBasic } from "@/lib/cards";
import { catalogStatus, defaultCardQuery, queryCards } from "@/services/cards";
import { database } from "@/services/database";
import {
  deleteDeck,
  duplicateDeck,
  listDecks,
  loadDeck,
  saveDeckToForge,
  validateDeck,
} from "@/services/decks";
import type {
  AppSettings,
  CatalogCard,
  DeckDetail,
  DeckDraft,
  DeckEntry,
  DeckSummary,
  DeckValidation,
  LeagueStatus,
} from "@/lib/types";

interface DeckBuilderProps {
  settings: AppSettings;
  revision: number;
  onChange: () => void;
  league: LeagueStatus;
}

type Notice = { kind: "success" | "error" | "info"; message: string };
type PendingAction =
  | { kind: "new" }
  | { kind: "load"; id: string }
  | { kind: "duplicate"; id: string };
const colorNames: Record<string, string> = {
  W: "White",
  U: "Blue",
  B: "Black",
  R: "Red",
  G: "Green",
  C: "Colorless",
};
const pageSize = 12;

function draftFrom(
  id: string | null,
  name: string,
  cards: DeckEntry[],
): DeckDraft {
  return {
    id,
    name,
    cards: cards.map(({ card, section, quantity }) => ({
      cardId: card.id,
      section,
      quantity,
    })),
  };
}

function signature(draft: DeckDraft) {
  return JSON.stringify({
    ...draft,
    cards: [...draft.cards].sort((a, b) =>
      `${a.section}${a.cardId}`.localeCompare(`${b.section}${b.cardId}`),
    ),
  });
}

function copyLimit(card: CatalogCard, normalCopyLimit: number) {
  if (
    /\bBasic\b.*\bLand\b/i.test(card.typeLine) ||
    /a deck can have any number of cards named/i.test(card.oracleText)
  )
    return Infinity;
  if (/a deck can have only one card named/i.test(card.oracleText)) return 1;
  const number = /a deck can have up to (\w+) cards named/i
    .exec(card.oracleText)?.[1]
    ?.toLowerCase();
  const words: Record<string, number> = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
    eleven: 11,
    twelve: 12,
    thirteen: 13,
    fourteen: 14,
    fifteen: 15,
    sixteen: 16,
    seventeen: 17,
    eighteen: 18,
    nineteen: 19,
    twenty: 20,
  };
  return number
    ? (words[number] ?? Number(number)) || normalCopyLimit
    : normalCopyLimit;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export default function DeckBuilder({
  settings,
  revision,
  onChange,
  league,
}: DeckBuilderProps) {
  const [decks, setDecks] = useState<DeckSummary[]>([]);
  const [loadingDecks, setLoadingDecks] = useState(true);
  const [id, setId] = useState<string | null>(null);
  const [name, setName] = useState("Untitled deck");
  const [entries, setEntries] = useState<DeckEntry[]>([]);
  const latestEntries = useRef<DeckEntry[]>([]);
  const [baseline, setBaseline] = useState(() =>
    signature(draftFrom(null, "Untitled deck", [])),
  );
  const [section, setSection] = useState<"main" | "sideboard">("main");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(
    null,
  );
  const [deleteTarget, setDeleteTarget] = useState<DeckSummary | null>(null);
  const [validation, setValidation] = useState<DeckValidation | null>(null);
  const [checking, setChecking] = useState(false);
  const [search, setSearch] = useState("");
  const [color, setColor] = useState("");
  const [rarity, setRarity] = useState("");
  const [basicOnly, setBasicOnly] = useState(false);
  const [selectedCard, setSelectedCard] = useState<CatalogCard | null>(null);
  const [page, setPage] = useState(0);
  const [pickerCards, setPickerCards] = useState<CatalogCard[]>([]);
  const [pickerTotal, setPickerTotal] = useState(0);
  const [pickerLoading, setPickerLoading] = useState(true);
  const [pickerError, setPickerError] = useState<string | null>(null);
  const [catalogCount, setCatalogCount] = useState<number | null>(null);
  const validationRequest = useRef(0);

  const draft = useMemo(
    () => draftFrom(id, name, entries),
    [id, name, entries],
  );
  const draftSignature = signature(draft);
  const dirty = draftSignature !== baseline;
  const mainCount = entries
    .filter((entry) => entry.section === "main")
    .reduce((sum, entry) => sum + entry.quantity, 0);
  const sideboardCount = entries
    .filter((entry) => entry.section === "sideboard")
    .reduce((sum, entry) => sum + entry.quantity, 0);
  const visibleEntries = entries
    .filter((entry) => entry.section === section)
    .sort(
      (a, b) =>
        a.card.cmc - b.card.cmc || a.card.name.localeCompare(b.card.name),
    );
  const selectedSummary = decks.find((deck) => deck.id === id);
  const ownershipKey = [...new Set(entries.map((entry) => entry.card.id))]
    .sort()
    .join("|");

  useEffect(() => {
    if (!ownershipKey) return;
    let cancelled = false;
    const cardIds = ownershipKey.split("|");
    void database()
      .then((db) =>
        db.select<{ card_id: string; quantity: number }[]>(
          `SELECT card_id, quantity FROM collection WHERE card_id IN (${cardIds.map((_, index) => `$${index + 1}`).join(",")})`,
          cardIds,
        ),
      )
      .then((rows) => {
        if (cancelled) return;
        const owned = new Map(rows.map((row) => [row.card_id, row.quantity]));
        const queried = new Set(cardIds);
        updateEntries((current) =>
          current.map((entry) =>
            queried.has(entry.card.id)
              ? {
                  ...entry,
                  card: { ...entry.card, owned: owned.get(entry.card.id) ?? 0 },
                }
              : entry,
          ),
        );
      })
      .catch((error: unknown) => {
        if (!cancelled)
          setNotice({
            kind: "error",
            message: `Could not refresh card ownership: ${errorMessage(error)}`,
          });
      });
    return () => {
      cancelled = true;
    };
  }, [revision, ownershipKey]);

  useEffect(() => {
    let cancelled = false;
    setLoadingDecks(true);
    listDecks()
      .then((result) => {
        if (!cancelled) setDecks(result);
      })
      .catch((error: unknown) => {
        if (!cancelled)
          setNotice({
            kind: "error",
            message: `Could not load decks: ${errorMessage(error)}`,
          });
      })
      .finally(() => {
        if (!cancelled) setLoadingDecks(false);
      });
    catalogStatus()
      .then((status) => {
        if (!cancelled) setCatalogCount(status.count);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [revision]);

  useEffect(() => {
    let cancelled = false;
    setPickerLoading(true);
    setPickerError(null);
    const timer = window.setTimeout(() => {
      queryCards({
        ...defaultCardQuery,
        search,
        ownedOnly: true,
        color,
        rarity,
        includeBasicLands: true,
        typeLine: basicOnly ? "Basic" : "",
        page,
        pageSize,
      })
        .then((result) => {
          if (!cancelled) {
            setPickerCards(result.cards);
            setPickerTotal(result.total);
          }
        })
        .catch((error: unknown) => {
          if (!cancelled) {
            setPickerCards([]);
            setPickerTotal(0);
            setPickerError(errorMessage(error));
          }
        })
        .finally(() => {
          if (!cancelled) setPickerLoading(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [search, color, rarity, basicOnly, page, revision]);

  useEffect(() => {
    const request = ++validationRequest.current;
    setChecking(true);
    setValidation(null);
    const timer = window.setTimeout(() => {
      validateDeck(draft, settings.forge.installDir || settings.forge.dataDir)
        .then((result) => {
          if (request === validationRequest.current) setValidation(result);
        })
        .catch((error: unknown) => {
          if (request === validationRequest.current)
            setNotice({
              kind: "error",
              message: `Deck validation failed: ${errorMessage(error)}`,
            });
        })
        .finally(() => {
          if (request === validationRequest.current) setChecking(false);
        });
    }, 300);
    return () => {
      window.clearTimeout(timer);
      validationRequest.current += 1;
    };
  }, [draft, settings.forge.dataDir, settings.forge.installDir, revision]);

  function installDeck(deck: DeckDetail) {
    setDeleteTarget(null);
    setId(deck.id);
    setName(deck.name);
    updateEntries(deck.cards);
    setSelectedCard(null);
    setBaseline(signature(draftFrom(deck.id, deck.name, deck.cards)));
    setNotice(null);
    setSection("main");
  }

  function resetDeck() {
    setDeleteTarget(null);
    setId(null);
    setName("Untitled deck");
    updateEntries([]);
    setSelectedCard(null);
    setBaseline(signature(draftFrom(null, "Untitled deck", [])));
    setNotice(null);
    setSection("main");
  }

  async function runTask(task: string, action: () => Promise<void>) {
    if (busy) return;
    setBusy(task);
    setNotice(null);
    try {
      await action();
    } catch (error) {
      setNotice({ kind: "error", message: errorMessage(error) });
    } finally {
      setBusy(null);
    }
  }

  async function performAction(action: PendingAction) {
    setPendingAction(null);
    if (action.kind === "new") {
      resetDeck();
      return;
    }
    await runTask(action.kind, async () => {
      const deck =
        action.kind === "load"
          ? await loadDeck(action.id)
          : await duplicateDeck(action.id);
      installDeck(deck);
      if (action.kind === "duplicate") {
        setDecks(await listDecks());
        onChange();
        setNotice({
          kind: "success",
          message:
            "Deck copied and saved to Forge. Both decks use the same collection.",
        });
      }
    });
  }

  function requestAction(action: PendingAction) {
    if (busy || (action.kind === "load" && action.id === id)) return;
    if (dirty) setPendingAction(action);
    else void performAction(action);
  }

  function updateEntries(
    update: DeckEntry[] | ((current: DeckEntry[]) => DeckEntry[]),
  ) {
    const next =
      typeof update === "function" ? update(latestEntries.current) : update;
    latestEntries.current = next;
    setEntries(next);
  }

  function printingCopies(card: CatalogCard, snapshot = entries) {
    return snapshot
      .filter((entry) => entry.card.id === card.id)
      .reduce((sum, entry) => sum + entry.quantity, 0);
  }

  function printingOwned(card: CatalogCard, snapshot = entries) {
    return (
      snapshot.find((entry) => entry.card.id === card.id)?.card.owned ??
      card.owned
    );
  }

  function addBlockedReason(
    card: CatalogCard,
    targetSection: "main" | "sideboard",
  ) {
    if (
      !isUnlimitedBasic(card) &&
      printingCopies(card) >= printingOwned(card)
    ) {
      return `All ${printingOwned(card)} owned copies of this printing are already in the main deck or sideboard.`;
    }
    const copies = entries
      .filter((entry) => entry.card.oracleId === card.oracleId)
      .reduce((sum, entry) => sum + entry.quantity, 0);
    const limit = copyLimit(
      card,
      settings.league.deckRestrictions.normalCopyLimit,
    );
    if (copies >= limit)
      return `${card.name} allows ${limit} copies across the main deck and sideboard.`;
    if (
      targetSection === "sideboard" &&
      sideboardCount >= settings.league.deckRestrictions.maximumSideboard
    ) {
      return `The sideboard already contains ${settings.league.deckRestrictions.maximumSideboard} cards.`;
    }
    return null;
  }

  const hasUnownedCards = entries.some(
    (entry) =>
      !isUnlimitedBasic(entry.card) &&
      printingCopies(entry.card) > printingOwned(entry.card),
  );

  function changeCard(
    card: CatalogCard,
    targetSection: "main" | "sideboard",
    delta: number,
  ): boolean {
    if (busy) return false;
    if (!Number.isSafeInteger(delta)) return false;
    const current = latestEntries.current;
    if (delta > 0) {
      const owned = printingOwned(card, current);
      if (
        !isUnlimitedBasic(card) &&
        printingCopies(card, current) + delta > owned
      ) {
        setNotice({
          kind: "info",
          message: `You own ${owned} ${owned === 1 ? "copy" : "copies"} of ${card.name} (${card.setCode.toUpperCase()} #${card.collectorNumber}). This change would use ${printingCopies(card, current) + delta} across the main deck and sideboard.`,
        });
        return false;
      }
      const copies = current
        .filter((entry) => entry.card.oracleId === card.oracleId)
        .reduce((sum, entry) => sum + entry.quantity, 0);
      const limit = copyLimit(
        card,
        settings.league.deckRestrictions.normalCopyLimit,
      );
      if (copies + delta > limit) {
        setNotice({
          kind: "info",
          message: `${card.name} allows ${limit} copies across the main deck and sideboard, including other printings.`,
        });
        return false;
      }
      if (
        targetSection === "sideboard" &&
        current
          .filter((entry) => entry.section === "sideboard")
          .reduce((sum, entry) => sum + entry.quantity, 0) +
          delta >
          settings.league.deckRestrictions.maximumSideboard
      ) {
        setNotice({
          kind: "info",
          message: `Your sideboard can contain up to ${settings.league.deckRestrictions.maximumSideboard} cards.`,
        });
        return false;
      }
    }
    updateEntries((current) => {
      const found = current.find(
        (entry) => entry.card.id === card.id && entry.section === targetSection,
      );
      if (!found)
        return delta > 0
          ? [...current, { card, section: targetSection, quantity: delta }]
          : current;
      return current
        .map((entry) =>
          entry === found
            ? { ...entry, quantity: entry.quantity + delta }
            : entry,
        )
        .filter((entry) => entry.quantity > 0);
    });
    setNotice(null);
    return true;
  }

  async function handleSave() {
    await runTask("save", async () => {
      const result = await saveDeckToForge(draft);
      installDeck(result.deck);
      setDecks(await listDecks());
      onChange();
      setNotice({ kind: "success", message: "Deck saved to Forge." });
    });
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    const target = deleteTarget;
    await runTask("delete", async () => {
      await deleteDeck(target.id);
      if (id === target.id) resetDeck();
      setDeleteTarget(null);
      setDecks(await listDecks());
      onChange();
      setNotice({
        kind: "success",
        message: `Deleted “${target.name}” from Eternal League. Its Forge file was removed too. Your collection is unchanged.`,
      });
    });
  }

  const curve = Array.from({ length: 7 }, (_, value) =>
    entries
      .filter(
        (entry) =>
          entry.section === "main" &&
          !/\bLand\b/i.test(entry.card.typeLine) &&
          Math.min(6, Math.floor(entry.card.cmc)) === value,
      )
      .reduce((sum, entry) => sum + entry.quantity, 0),
  );
  const curveMax = Math.max(1, ...curve);
  const colors = Object.keys(colorNames).map((key) => ({
    key,
    count: entries
      .filter(
        (entry) =>
          entry.section === "main" &&
          (key === "C"
            ? !entry.card.colors.length
            : entry.card.colors.includes(key)),
      )
      .reduce((sum, entry) => sum + entry.quantity, 0),
  }));

  return (
    <div className="deck-builder-page">
      {notice && (
        <div
          className={`notice notice-${notice.kind}`}
          role={notice.kind === "error" ? "alert" : "status"}
        >
          {notice.kind === "error" ? (
            <AlertTriangle size={17} />
          ) : (
            <CheckCircle2 size={17} />
          )}
          <span>{notice.message}</span>
          <button
            type="button"
            className="deck-dismiss"
            onClick={() => setNotice(null)}
            aria-label="Dismiss deck message"
          >
            <X size={15} />
          </button>
        </div>
      )}
      {pendingAction && (
        <div className="notice notice-info deck-confirm" role="alert">
          <div>
            <strong>Keep your current changes?</strong>
            <p>
              This deck has unsaved changes. Save it first, or discard the edits
              to continue.
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setPendingAction(null)}
          >
            Keep editing
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void performAction(pendingAction)}
          >
            Discard changes
          </Button>
        </div>
      )}
      {deleteTarget && (
        <div className="notice notice-error deck-confirm" role="alert">
          <div>
            <strong>Delete “{deleteTarget.name}”?</strong>
            <p>
              This removes the deck from Eternal League and its managed Forge
              file. Your collected cards stay available.
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setDeleteTarget(null)}
            disabled={!!busy}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => void handleDelete()}
            disabled={!!busy}
          >
            Delete deck
          </Button>
        </div>
      )}

      {hasUnownedCards && (
        <div className="notice notice-error" role="alert">
          <AlertTriangle size={17} />
          <span>
            This deck contains copies you do not own. Reduce their quantities or
            remove them before saving or copying the deck.
          </span>
        </div>
      )}

      <div className="deck-workspace">
        <aside className="panel deck-library">
          <div className="panel-header">
            <div>
              <h2 className="section-title">Decks</h2>
            </div>
            <span className="badge badge-muted">{decks.length}</span>
          </div>
          <div className="deck-library-actions">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => requestAction({ kind: "new" })}
              disabled={!!busy}
            >
              <Plus size={15} /> New deck
            </Button>
          </div>
          <div className="deck-list">
            {loadingDecks ? (
              <p className="field-hint deck-list-empty">
                <Loader2 size={15} className="animate-spin" /> Loading saved
                decks…
              </p>
            ) : !decks.length ? (
              <div className="deck-list-empty">
                <Swords size={25} strokeWidth={1.3} />
                <p>Your next deck starts here.</p>
                <span className="field-hint">
                  Name a deck, add cards, and save it.
                </span>
              </div>
            ) : (
              decks.map((deck) => (
                <button
                  type="button"
                  key={deck.id}
                  className={`deck-list-item ${deck.id === id ? "active" : ""}`}
                  onClick={() => requestAction({ kind: "load", id: deck.id })}
                  disabled={!!busy}
                  aria-pressed={deck.id === id}
                >
                  <strong>{deck.name}</strong>
                  <span>
                    {deck.mainCount} main <span>·</span> {deck.sideboardCount}{" "}
                    sideboard
                  </span>
                </button>
              ))
            )}
          </div>
          <p className="deck-library-note">
            Cards stay available across every deck. Saving a deck never consumes
            your collection.
          </p>
        </aside>

        <section className="panel deck-editor">
          <div className="deck-editor-heading">
            <div className="field">
              <Label htmlFor="deck-name">
                Deck name{" "}
                {dirty && <span className="deck-unsaved">· Unsaved</span>}
              </Label>
              <Input
                id="deck-name"
                value={name}
                maxLength={100}
                onChange={(event) => {
                  setName(event.target.value);
                }}
                disabled={!!busy}
              />
            </div>
            <div className="deck-editor-actions">
              <Button
                size="sm"
                variant="outline"
                aria-label="Copy deck"
                title="Copy deck"
                disabled={!!busy || !id || hasUnownedCards}
                onClick={() => id && requestAction({ kind: "duplicate", id })}
              >
                <Copy size={15} /> Copy deck
              </Button>
              <Button
                size="icon"
                variant="ghost"
                aria-label="Delete saved deck"
                title="Delete saved deck"
                disabled={!!busy || !selectedSummary}
                onClick={() =>
                  selectedSummary && setDeleteTarget(selectedSummary)
                }
              >
                <Trash2 size={16} />
              </Button>
            </div>
          </div>
          <div
            className="deck-section-tabs"
            role="tablist"
            aria-label="Deck sections"
          >
            <button
              type="button"
              role="tab"
              id="deck-tab-main"
              aria-selected={section === "main"}
              aria-controls="deck-card-list"
              className={section === "main" ? "active" : ""}
              onClick={() => setSection("main")}
            >
              Main deck <span>{mainCount}</span>
            </button>
            <button
              type="button"
              role="tab"
              id="deck-tab-sideboard"
              aria-selected={section === "sideboard"}
              aria-controls="deck-card-list"
              className={section === "sideboard" ? "active" : ""}
              onClick={() => setSection("sideboard")}
            >
              Sideboard{" "}
              <span>
                {sideboardCount} /{" "}
                {settings.league.deckRestrictions.maximumSideboard}
              </span>
            </button>
          </div>
          <div
            id="deck-card-list"
            className={`deck-entries ${visibleEntries.length ? "deck-tiles" : ""}`}
            role="tabpanel"
            aria-labelledby={`deck-tab-${section}`}
          >
            {!visibleEntries.length ? (
              <div className="deck-entries-empty">
                <Layers3 size={30} strokeWidth={1.1} />
                <h3>
                  {section === "main"
                    ? "Find the heart of your deck."
                    : "Prepare for the next game."}
                </h3>
                <p>
                  Choose cards from the browser to add them to your{" "}
                  {section === "main" ? "main deck" : "sideboard"}.
                </p>
              </div>
            ) : (
              visibleEntries.map((entry) => (
                <article
                  className="deck-tile"
                  key={`${id}:${entry.card.id}:${entry.section}`}
                >
                  <div className="deck-tile-art">
                    <CardImage
                      card={entry.card}
                      imageCacheDir={settings.forge.imageCacheDir}
                    />
                    <button
                      type="button"
                      className="card-art-trigger"
                      onClick={() => setSelectedCard(entry.card)}
                      aria-label={`View ${entry.card.name} artwork and details`}
                    />
                  </div>
                  <div className="deck-tile-copy">
                    <button
                      type="button"
                      className="deck-card-name"
                      onClick={() => setSelectedCard(entry.card)}
                      aria-label={`View ${entry.card.name} details`}
                      title={entry.card.name}
                    >
                      {entry.card.name}
                    </button>
                    <span className="deck-tile-mana">
                      {formatMana(entry.card.manaCost) ||
                        (/\bLand\b/.test(entry.card.typeLine)
                          ? "Land"
                          : "No mana cost")}
                    </span>
                    <span>
                      {entry.card.setCode.toUpperCase()} #
                      {entry.card.collectorNumber}
                    </span>
                    <small>
                      {isUnlimitedBasic(entry.card)
                        ? "Unlimited basic land"
                        : `${entry.card.owned} owned`}
                    </small>
                    <div className="deck-tile-controls">
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label={`Remove one ${entry.card.name} from ${section}`}
                        onClick={() => changeCard(entry.card, section, -1)}
                        disabled={!!busy}
                      >
                        <Minus size={15} />
                      </Button>
                      <span
                        className="deck-tile-count"
                        aria-label={`Quantity of ${entry.card.name} in ${section}`}
                      >
                        {entry.quantity}
                      </span>
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label={`Add one ${entry.card.name} to ${section}`}
                        onClick={() => changeCard(entry.card, section, 1)}
                        disabled={
                          !!busy || !!addBlockedReason(entry.card, section)
                        }
                        title={
                          addBlockedReason(entry.card, section) ??
                          "Add one copy"
                        }
                      >
                        <Plus size={15} />
                      </Button>
                    </div>
                  </div>
                </article>
              ))
            )}
          </div>

          <div className="deck-analytics">
            <div className="deck-curve">
              <span className="eyebrow">MANA CURVE · NONLANDS</span>
              <div
                className="deck-curve-bars"
                aria-label="Main deck mana curve"
              >
                {curve.map((count, index) => (
                  <div
                    className="deck-curve-column"
                    key={index}
                    title={`${index === 6 ? "6 or more" : index} mana: ${count} cards`}
                  >
                    <span className="deck-curve-value">{count || ""}</span>
                    <div className="deck-curve-track">
                      <div style={{ height: `${(count / curveMax) * 100}%` }} />
                    </div>
                    <small>{index === 6 ? "6+" : index}</small>
                  </div>
                ))}
              </div>
            </div>
            <div className="deck-colors">
              <span className="eyebrow">CARD COLORS</span>
              <div>
                {colors.map(({ key, count }) => (
                  <span
                    key={key}
                    title={`${colorNames[key]}: ${count} main-deck cards`}
                  >
                    <i className={`mana-color mana-${key.toLowerCase()}`}>
                      {key}
                    </i>
                    <strong>{count}</strong>
                  </span>
                ))}
              </div>
              <p>Multicolor cards count toward each color.</p>
            </div>
          </div>

          <div className="deck-validation" aria-live="polite">
            {checking ? (
              <p className="field-hint">
                <Loader2 size={14} className="animate-spin" /> Checking deck…
              </p>
            ) : validation ? (
              validation.warnings.length ? (
                <>
                  <span className="deck-validation-title">
                    <AlertTriangle size={15} /> {validation.warnings.length}{" "}
                    {validation.warnings.length === 1 ? "warning" : "warnings"}
                  </span>
                  <ul>
                    {validation.warnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                </>
              ) : (
                <p className="deck-validation-ok">
                  <CheckCircle2 size={15} /> Ready for Forge.
                </p>
              )
            ) : (
              <p className="field-hint">
                Validation is unavailable. You can still save a draft.
              </p>
            )}
          </div>
          <div className="deck-save-bar">
            <div>
              <Button
                size="sm"
                onClick={() => void handleSave()}
                disabled={
                  !!busy || hasUnownedCards || !name.trim() || (!dirty && !!id)
                }
                title={
                  hasUnownedCards
                    ? "Remove cards you do not own before saving."
                    : undefined
                }
              >
                {busy === "save" ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Save size={14} />
                )}{" "}
                Save deck
              </Button>
            </div>
          </div>
        </section>

        <aside className="panel deck-picker">
          <div className="panel-header">
            <div>
              <h2 className="section-title">Cards</h2>
            </div>
            <Search size={17} className="muted-icon" />
          </div>
          <div className="deck-picker-filters">
            <Label htmlFor="deck-card-search" className="sr-only">
              Search cards for your deck
            </Label>
            <Input
              id="deck-card-search"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(0);
              }}
              placeholder="Search card names…"
            />
            <div className="deck-picker-toggles">
              <button
                type="button"
                className={!basicOnly ? "active" : ""}
                aria-pressed={!basicOnly}
                onClick={() => {
                  setBasicOnly(false);
                  setPage(0);
                }}
              >
                Owned cards
              </button>
              <button
                type="button"
                className={basicOnly ? "active" : ""}
                aria-pressed={basicOnly}
                onClick={() => {
                  setBasicOnly(!basicOnly);
                  setSearch("");
                  setColor("");
                  setRarity("");
                  setPage(0);
                }}
              >
                Basic lands
              </button>
            </div>
            <div className="deck-picker-selects">
              <label>
                <span className="sr-only">Filter deck cards by color</span>
                <select
                  value={color}
                  onChange={(event) => {
                    setColor(event.target.value);
                    setPage(0);
                  }}
                >
                  <option value="">All colors</option>
                  {Object.entries(colorNames).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span className="sr-only">Filter deck cards by rarity</span>
                <select
                  value={rarity}
                  onChange={(event) => {
                    setRarity(event.target.value);
                    setPage(0);
                  }}
                >
                  <option value="">All rarities</option>
                  {["common", "uncommon", "rare", "mythic"].map((value) => (
                    <option value={value} key={value}>
                      {value[0].toUpperCase() + value.slice(1)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <p className="field-hint">
              Adding to{" "}
              <strong>{section === "main" ? "main deck" : "sideboard"}</strong>{" "}
              · {pickerTotal.toLocaleString()} matching printings
            </p>
            <p className="field-hint">
              Only owned printings can be added. Basic lands are unlimited.
            </p>
          </div>
          <div className="deck-picker-results" aria-busy={pickerLoading}>
            {pickerLoading ? (
              <div className="deck-picker-empty">
                <Loader2 size={23} className="animate-spin" />
                <p>Searching your catalog…</p>
              </div>
            ) : pickerError ? (
              <div className="deck-picker-empty">
                <AlertTriangle size={23} />
                <p>{pickerError}</p>
              </div>
            ) : !pickerCards.length ? (
              <div className="deck-picker-empty">
                <Layers3 size={28} strokeWidth={1.2} />
                <h3>
                  {catalogCount === 0
                    ? "Your catalog is waiting."
                    : "No cards match yet."}
                </h3>
                <p>
                  {catalogCount === 0
                    ? "Your card catalog is being prepared automatically. Check the Forge folders in Settings if setup cannot finish."
                    : "Open booster packs or craft cards, or try different filters. Basic lands are always available."}
                </p>
              </div>
            ) : (
              pickerCards.map((card) => (
                <div className="deck-picker-card" key={card.id}>
                  <div className="deck-card-art">
                    <CardImage
                      card={card}
                      imageCacheDir={settings.forge.imageCacheDir}
                      className="deck-picker-art"
                    />
                    <button
                      type="button"
                      className="card-art-trigger"
                      onClick={() => setSelectedCard(card)}
                      aria-label={`View ${card.name} artwork and details`}
                    />
                  </div>
                  <div>
                    <button
                      type="button"
                      className="deck-card-name"
                      onClick={() => setSelectedCard(card)}
                      aria-label={`View ${card.name} details`}
                    >
                      {card.name}
                    </button>
                    <span>
                      {card.setCode.toUpperCase()} #{card.collectorNumber}{" "}
                      <span>·</span>{" "}
                      {isUnlimitedBasic(card)
                        ? "Unlimited"
                        : `${card.owned} owned`}
                    </span>
                    <small>{card.typeLine}</small>
                  </div>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={`Add ${card.name} ${card.setCode.toUpperCase()} ${card.collectorNumber} to ${section}`}
                    onClick={() => changeCard(card, section, 1)}
                    disabled={!!busy || !!addBlockedReason(card, section)}
                    title={addBlockedReason(card, section) ?? "Add one copy"}
                  >
                    <Plus size={16} />
                  </Button>
                </div>
              ))
            )}
          </div>
          {pickerTotal > pageSize && (
            <div className="deck-picker-pagination">
              <Button
                variant="ghost"
                size="icon"
                aria-label="Previous card page"
                onClick={() => setPage((current) => Math.max(0, current - 1))}
                disabled={page === 0 || pickerLoading}
              >
                <ChevronLeft size={16} />
              </Button>
              <span>
                {page + 1} / {Math.ceil(pickerTotal / pageSize)}
              </span>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Next card page"
                onClick={() => setPage((current) => current + 1)}
                disabled={(page + 1) * pageSize >= pickerTotal || pickerLoading}
              >
                <ChevronRight size={16} />
              </Button>
            </div>
          )}
        </aside>
      </div>
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
