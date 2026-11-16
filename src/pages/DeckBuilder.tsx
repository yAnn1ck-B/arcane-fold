import "@/styles/deck-browser.css";
import { formatMana } from "@/lib/mana";
import { createPortal } from "react-dom";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Copy,
  Layers3,
  Loader2,
  Minus,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  Save,
  Swords,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import CardImage from "@/components/CardImage";
import CardDetails from "@/components/CardDetails";
import CardFilters, { getCardFilterScope } from "@/components/CardFilters";
import { isUnlimitedBasic } from "@/lib/cards";
import {
  catalogStatus,
  defaultCardQuery,
  getCard,
  getCardFilterOptions,
  getCardPrintings,
  queryCards,
} from "@/services/cards";
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
  CardFilterOptions,
  CardQuery,
  DeckAddRequest,
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
  addRequest?: DeckAddRequest | null;
  onAddRequestHandled?: (requestId: string) => void;
  onAddComplete?: (message: string) => void;
}
type Section = "main" | "sideboard";
type Notice = { kind: "success" | "error" | "info"; message: string };
type PendingAction =
  { kind: "new" } | { kind: "load" | "duplicate"; id: string };
type CardGroup = { card: CatalogCard; entries: DeckEntry[]; quantity: number };
type CardsPerRow = "auto" | "2" | "3" | "4" | "5" | "6";
const densityStorageKey = "eternal-league.deck-cards-per-row";
function savedCardsPerRow(): CardsPerRow {
  try {
    const value = localStorage.getItem(densityStorageKey);
    if (value && ["auto", "2", "3", "4", "5", "6"].includes(value))
      return value as CardsPerRow;
  } catch {
    /* Storage can be unavailable in a restricted webview. */
  }
  return "auto";
}
type AddFlow = {
  request: DeckAddRequest;
  targetId: string;
  name: string;
  section: Section;
  card: CatalogCard;
  defaultCard: CatalogCard;
  printingExplicit: boolean;
  quantity: number;
};
const pageSize = 12;
const emptyOptions: CardFilterOptions = {
  colors: [],
  manaValues: [],
  rarities: [],
  sets: [],
  cardTypes: [],
};
const colorNames: Record<string, string> = {
  W: "White",
  U: "Blue",
  B: "Black",
  R: "Red",
  G: "Green",
  C: "Colorless",
};
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
function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
function ownedCount(card: CatalogCard) {
  return card.oracleOwned ?? card.owned;
}
function oracleCopies(card: CatalogCard, entries: DeckEntry[]) {
  return entries
    .filter((entry) => entry.card.oracleId === card.oracleId)
    .reduce((sum, entry) => sum + entry.quantity, 0);
}
function copyLimit(card: CatalogCard, normal: number) {
  if (
    isUnlimitedBasic(card) ||
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
  return number ? (words[number] ?? Number(number)) || normal : normal;
}
function normalizePrintings(
  entries: DeckEntry[],
  selected?: CatalogCard,
): DeckEntry[] {
  const printing = new Map<string, CatalogCard>();
  if (selected) printing.set(selected.oracleId, selected);
  const rows = new Map<string, DeckEntry>();
  for (const entry of entries) {
    if (!printing.has(entry.card.oracleId))
      printing.set(entry.card.oracleId, entry.card);
    const card = printing.get(entry.card.oracleId)!;
    const key = `${entry.section}:${card.oracleId}`;
    const existing = rows.get(key);
    if (existing) existing.quantity += entry.quantity;
    else rows.set(key, { ...entry, card });
  }
  return [...rows.values()];
}
function withCard(
  entries: DeckEntry[],
  card: CatalogCard,
  section: Section,
  delta: number,
): DeckEntry[] {
  const current = normalizePrintings(entries);
  const existingPrinting = current.find(
    (entry) => entry.card.oracleId === card.oracleId,
  )?.card;
  const selected = existingPrinting
    ? { ...existingPrinting, oracleOwned: ownedCount(card) }
    : card;
  const found = current.find(
    (entry) =>
      entry.card.oracleId === card.oracleId && entry.section === section,
  );
  if (!found)
    return delta > 0
      ? [...current, { card: selected, section, quantity: delta }]
      : current;
  return current
    .map((entry) =>
      entry === found
        ? { ...entry, card: selected, quantity: entry.quantity + delta }
        : entry,
    )
    .filter((entry) => entry.quantity > 0);
}
function DeckCardTitle({
  card,
  onDetails,
}: {
  card: CatalogCard;
  onDetails: () => void;
}) {
  const mana = formatMana(card.manaCost);
  return (
    <div className="deck-card-title-row">
      <button
        type="button"
        className="deck-oracle-name"
        title={card.name}
        onClick={onDetails}
      >
        {card.name}
      </button>
      {mana && (
        <span className="deck-card-title-mana" title={mana}>
          {mana}
        </span>
      )}
    </div>
  );
}
function DeckDialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return createPortal(
    <dialog
      ref={dialog}
      className="deck-dialog"
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === dialog.current) onClose();
      }}
    >
      <div className="deck-dialog-heading">
        <h2>{title}</h2>
        <Button
          variant="ghost"
          size="icon"
          onClick={onClose}
          aria-label={`Close ${title}`}
        >
          <X size={18} />
        </Button>
      </div>
      {children}
    </dialog>,
    document.body,
  );
}

export default function DeckBuilder({
  settings,
  revision,
  onChange,
  league,
  addRequest,
  onAddRequestHandled,
  onAddComplete,
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
  const [section, setSection] = useState<Section>("main");
  const [busy, setBusy] = useState<string | null>(null);
  const taskRunning = useRef(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(
    null,
  );
  const [deleteTarget, setDeleteTarget] = useState<DeckSummary | null>(null);
  const [validation, setValidation] = useState<DeckValidation | null>(null);
  const [checking, setChecking] = useState(false);
  const validationRequest = useRef(0);
  const [selectedCard, setSelectedCard] = useState<CatalogCard | null>(null);
  const [browserOpen, setBrowserOpen] = useState(true);
  const [cardsPerRow, setCardsPerRow] = useState<CardsPerRow>(savedCardsPerRow);
  const [availableColumns, setAvailableColumns] = useState(2);
  const editor = useRef<HTMLElement>(null);
  const [query, setQuery] = useState<CardQuery>(() => ({
    ...defaultCardQuery,
    ownedOnly: true,
    includeBasicLands: true,
    groupByOracle: true,
    availableOnly: true,
    pageSize,
  }));
  const [options, setOptions] = useState<CardFilterOptions>(emptyOptions);
  const [pickerCards, setPickerCards] = useState<CatalogCard[]>([]);
  const [pickerTotal, setPickerTotal] = useState(0);
  const [pickerLoading, setPickerLoading] = useState(false);
  const [pickerHasResult, setPickerHasResult] = useState(false);
  const lastFilterKey = useRef<string | null>(null);
  const pickerReady = useRef(false);
  const [pickerError, setPickerError] = useState<string | null>(null);
  const [catalogCount, setCatalogCount] = useState<number | null>(null);
  const [preferred, setPreferred] = useState<Record<string, CatalogCard>>({});
  const [addFlow, setAddFlow] = useState<AddFlow | null>(null);
  const [targetDeck, setTargetDeck] = useState<DeckDetail | null>(null);
  const [targetLoading, setTargetLoading] = useState(false);
  const [targetError, setTargetError] = useState<string | null>(null);
  const [targetPrintingLoading, setTargetPrintingLoading] = useState(false);
  const draft = useMemo(
    () => draftFrom(id, name, entries),
    [id, name, entries],
  );
  const dirty = signature(draft) !== baseline;
  const mainCount = entries
    .filter((entry) => entry.section === "main")
    .reduce((sum, entry) => sum + entry.quantity, 0);
  const sideboardCount = entries
    .filter((entry) => entry.section === "sideboard")
    .reduce((sum, entry) => sum + entry.quantity, 0);
  const selectedSummary = decks.find((deck) => deck.id === id);
  const allocated = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const entry of entries)
      counts[entry.card.oracleId] =
        (counts[entry.card.oracleId] ?? 0) + entry.quantity;
    return counts;
  }, [entries]);
  const effectiveQuery = useMemo(
    () => ({ ...query, allocated }),
    [query, allocated],
  );
  const ownershipKey = [...new Set(entries.map((entry) => entry.card.id))]
    .sort()
    .join("|");
  const groups = useMemo(() => {
    const byOracle = new Map<string, CardGroup>();
    for (const entry of entries.filter((item) => item.section === section)) {
      const group = byOracle.get(entry.card.oracleId);
      if (group) {
        group.entries.push(entry);
        group.quantity += entry.quantity;
      } else
        byOracle.set(entry.card.oracleId, {
          card: entry.card,
          entries: [entry],
          quantity: entry.quantity,
        });
    }
    return [...byOracle.values()].sort(
      (a, b) =>
        a.card.cmc - b.card.cmc || a.card.name.localeCompare(b.card.name),
    );
  }, [entries, section]);
  const columns = Math.max(
    1,
    Math.min(
      availableColumns,
      cardsPerRow === "auto" ? 4 : Number(cardsPerRow),
    ),
  );
  const availablePickerCards = pickerCards.filter(
    (card) =>
      isUnlimitedBasic(card) ||
      (allocated[card.oracleId] ?? 0) < ownedCount(card),
  );
  function updateEntries(
    update: DeckEntry[] | ((current: DeckEntry[]) => DeckEntry[]),
  ) {
    const next =
      typeof update === "function" ? update(latestEntries.current) : update;
    const normalized = normalizePrintings(next);
    latestEntries.current = normalized;
    setEntries(normalized);
  }

  useEffect(() => {
    try {
      localStorage.setItem(densityStorageKey, cardsPerRow);
    } catch {
      /* Keep the preference for this session. */
    }
  }, [cardsPerRow]);
  useEffect(() => {
    if (!editor.current) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width > 0)
        setAvailableColumns(
          Math.max(
            1,
            Math.min(6, Math.floor((entry.contentRect.width - 20) / 144)),
          ),
        );
    });
    observer.observe(editor.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!ownershipKey) return;
    let active = true;
    Promise.all(ownershipKey.split("|").map(getCard))
      .then((cards) => {
        if (!active) return;
        const ownership = new Map(cards.map((card) => [card.id, card]));
        updateEntries((current) =>
          current.map((entry) => {
            const fresh = ownership.get(entry.card.id);
            return fresh
              ? {
                  ...entry,
                  card: {
                    ...entry.card,
                    owned: fresh.owned,
                    oracleOwned: ownedCount(fresh),
                  },
                }
              : entry;
          }),
        );
      })
      .catch((error: unknown) => {
        if (active)
          setNotice({
            kind: "error",
            message: `Could not refresh card ownership: ${errorMessage(error)}`,
          });
      });
    return () => {
      active = false;
    };
  }, [revision, ownershipKey]);
  useEffect(() => {
    let active = true;
    setLoadingDecks(true);
    listDecks()
      .then((result) => {
        if (active) setDecks(result);
      })
      .catch((error: unknown) => {
        if (active) setNotice({ kind: "error", message: errorMessage(error) });
      })
      .finally(() => {
        if (active) setLoadingDecks(false);
      });
    catalogStatus()
      .then((status) => {
        if (active) setCatalogCount(status.count);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [revision]);
  useEffect(() => {
    let active = true;
    getCardFilterOptions({
      ...getCardFilterScope(effectiveQuery),
      availableOnly: false,
      allocated: {},
    })
      .then((result) => {
        if (active) setOptions(result);
      })
      .catch((error: unknown) => {
        if (active) setPickerError(errorMessage(error));
      });
    return () => {
      active = false;
    };
  }, [revision]);
  useEffect(() => {
    let active = true;
    const filterKey = JSON.stringify({ ...effectiveQuery, allocated: {} });
    const foreground =
      !pickerReady.current || filterKey !== lastFilterKey.current;
    lastFilterKey.current = filterKey;
    setPickerLoading(false);
    setPickerError(null);
    const loadingTimer = foreground
      ? window.setTimeout(() => {
          if (active) setPickerLoading(true);
        }, 300)
      : undefined;
    const timer = window.setTimeout(
      () => {
        queryCards(effectiveQuery)
          .then((result) => {
            if (!active) return;
            pickerReady.current = true;
            setPickerHasResult(true);
            if (!result.cards.length && result.total > 0 && query.page > 0) {
              setQuery((current) => ({
                ...current,
                page: Math.max(0, Math.ceil(result.total / pageSize) - 1),
              }));
              return;
            }
            setPickerCards(result.cards);
            setPickerTotal(result.total);
          })
          .catch((error: unknown) => {
            if (active) setPickerError(errorMessage(error));
          })
          .finally(() => {
            window.clearTimeout(loadingTimer);
            if (active) setPickerLoading(false);
          });
      },
      foreground ? 180 : 0,
    );
    return () => {
      active = false;
      window.clearTimeout(timer);
      window.clearTimeout(loadingTimer);
    };
  }, [effectiveQuery, revision]);
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
  }, [draft, settings.forge.installDir, settings.forge.dataDir, revision]);
  useEffect(() => {
    if (!addRequest) return;
    setAddFlow({
      request: addRequest,
      targetId: id ?? (dirty ? "draft" : (decks[0]?.id ?? "new")),
      name: "Untitled deck",
      section: "main",
      card: addRequest.card,
      defaultCard: addRequest.card,
      printingExplicit: false,
      quantity: 1,
    });
    setTargetError(null);
    setTargetPrintingLoading(true);
    let active = true;
    Promise.all([getCardPrintings(addRequest.card.oracleId), listDecks()])
      .then(([cards, availableDecks]) => {
        if (!active) return;
        const chosen =
          cards.find((card) => card.id === addRequest.card.id) ?? cards[0];
        if (!chosen)
          throw new Error(
            "No printing is unlocked for this card. Collect it from a league-unlocked expansion first.",
          );
        setDecks(availableDecks);
        setAddFlow((flow) =>
          flow?.request.requestId === addRequest.requestId
            ? {
                ...flow,
                targetId:
                  id ?? (dirty ? "draft" : (availableDecks[0]?.id ?? "new")),
                card: chosen,
                defaultCard: chosen,
              }
            : flow,
        );
      })
      .catch((error: unknown) => {
        if (active) setTargetError(errorMessage(error));
      })
      .finally(() => {
        if (active) setTargetPrintingLoading(false);
      });
    return () => {
      active = false;
    };
  }, [addRequest?.requestId]);
  useEffect(() => {
    if (
      !addFlow ||
      addFlow.targetId === "new" ||
      addFlow.targetId === "draft" ||
      addFlow.targetId === id
    ) {
      setTargetDeck(null);
      setTargetLoading(false);
      return;
    }
    let active = true;
    setTargetLoading(true);
    setTargetError(null);
    loadDeck(addFlow.targetId)
      .then((deck) => {
        if (active) setTargetDeck(deck);
      })
      .catch((error: unknown) => {
        if (active) setTargetError(errorMessage(error));
      })
      .finally(() => {
        if (active) setTargetLoading(false);
      });
    return () => {
      active = false;
    };
  }, [addFlow?.targetId, id]);

  useEffect(() => {
    if (
      !addFlow ||
      addFlow.printingExplicit ||
      targetPrintingLoading ||
      targetLoading
    )
      return;
    const isCurrent = addFlow.targetId === id || addFlow.targetId === "draft";
    if (
      !isCurrent &&
      addFlow.targetId !== "new" &&
      targetDeck?.id !== addFlow.targetId
    )
      return;
    const targetCards = isCurrent
      ? entries
      : addFlow.targetId === "new"
        ? []
        : (targetDeck?.cards ?? []);
    const existing = targetCards.find(
      (entry) => entry.card.oracleId === addFlow.request.card.oracleId,
    )?.card;
    const selected = existing ?? addFlow.defaultCard;
    setAddFlow((flow) => {
      if (
        !flow ||
        flow.request.requestId !== addFlow.request.requestId ||
        flow.targetId !== addFlow.targetId ||
        flow.printingExplicit ||
        flow.card.id === selected.id
      )
        return flow;
      return { ...flow, card: selected };
    });
  }, [
    addFlow?.request.requestId,
    addFlow?.targetId,
    addFlow?.printingExplicit,
    addFlow?.defaultCard.id,
    id,
    entries,
    targetDeck,
    targetPrintingLoading,
    targetLoading,
  ]);

  function installDeck(deck: DeckDetail, selectColors = true) {
    setDeleteTarget(null);
    setId(deck.id);
    setName(deck.name);
    updateEntries(deck.cards);
    setSelectedCard(null);
    setPreferred({});
    setBaseline(signature(draftFrom(deck.id, deck.name, deck.cards)));
    setNotice(null);
    if (selectColors) {
      setSection("main");
      const colors = [
        ...new Set(deck.cards.flatMap((entry) => entry.card.colors)),
      ];
      setQuery((current) => ({
        ...current,
        colors: deck.cards.length ? [...new Set([...colors, "C"])] : [],
        color: "",
        page: 0,
      }));
    }
  }
  function resetDeck() {
    setDeleteTarget(null);
    setId(null);
    setName("Untitled deck");
    updateEntries([]);
    setSelectedCard(null);
    setPreferred({});
    setBaseline(signature(draftFrom(null, "Untitled deck", [])));
    setNotice(null);
    setSection("main");
    setQuery((current) => ({ ...current, colors: [], color: "", page: 0 }));
  }
  async function runTask(task: string, action: () => Promise<void>) {
    if (taskRunning.current) return;
    taskRunning.current = true;
    setBusy(task);
    setNotice(null);
    try {
      await action();
    } catch (error) {
      setNotice({ kind: "error", message: errorMessage(error) });
    } finally {
      taskRunning.current = false;
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
          message: "Deck copied and saved to Forge.",
        });
      }
    });
  }
  function requestAction(action: PendingAction) {
    if (busy || (action.kind === "load" && action.id === id)) return;
    if (dirty) setPendingAction(action);
    else void performAction(action);
  }
  function blockedReason(
    card: CatalogCard,
    target: Section,
    snapshot = entries,
    delta = 1,
  ) {
    const copies = oracleCopies(card, snapshot);
    if (!isUnlimitedBasic(card) && copies + delta > ownedCount(card))
      return `All ${ownedCount(card)} owned copies of ${card.name} are already allocated, or this change would exceed your collection.`;
    const limit = copyLimit(
      card,
      settings.league.deckRestrictions.normalCopyLimit,
    );
    if (copies + delta > limit)
      return `${card.name} allows ${limit} copies across the main deck and sideboard.`;
    if (
      target === "sideboard" &&
      snapshot
        .filter((entry) => entry.section === "sideboard")
        .reduce((sum, entry) => sum + entry.quantity, 0) +
        delta >
        settings.league.deckRestrictions.maximumSideboard
    )
      return `The sideboard can contain up to ${settings.league.deckRestrictions.maximumSideboard} cards.`;
    return null;
  }
  function changeCard(card: CatalogCard, target: Section, delta: number) {
    if (!Number.isSafeInteger(delta)) return false;
    const reason =
      delta > 0
        ? blockedReason(card, target, latestEntries.current, delta)
        : null;
    if (reason) {
      setNotice({ kind: "info", message: reason });
      return false;
    }
    updateEntries((current) => withCard(current, card, target, delta));
    setNotice(null);
    return true;
  }
  function removeGroupCard(group: CardGroup) {
    changeCard(group.card, section, -1);
  }
  const hasUnownedCards = entries.some(
    (entry) =>
      !isUnlimitedBasic(entry.card) &&
      oracleCopies(entry.card, entries) > ownedCount(entry.card),
  );
  async function handleSave() {
    await runTask("save", async () => {
      const result = await saveDeckToForge(
        draftFrom(id, name, latestEntries.current),
      );
      installDeck(result.deck, false);
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
        message: `Deleted “${target.name}” and its Forge file.`,
      });
    });
  }
  function closeAddFlow() {
    if (taskRunning.current) return;
    if (addFlow) onAddRequestHandled?.(addFlow.request.requestId);
    setAddFlow(null);
    setTargetError(null);
  }
  async function confirmCollectionAdd() {
    if (!addFlow) return;
    const flow = addFlow;
    await runTask("collection-add", async () => {
      setTargetError(null);
      try {
        const target =
          flow.targetId === "new"
            ? null
            : flow.targetId === id || flow.targetId === "draft"
              ? { id, name, cards: latestEntries.current }
              : await loadDeck(flow.targetId);
        const cards = target?.cards ?? [];
        const existing = cards.find(
          (entry) => entry.card.oracleId === flow.card.oracleId,
        )?.card;
        const selectedId = flow.printingExplicit
          ? flow.card.id
          : (existing?.id ?? flow.defaultCard.id);
        const printings = await getCardPrintings(flow.card.oracleId);
        const card = printings.find((item) => item.id === selectedId);
        if (!card)
          throw new Error(
            "The selected printing is no longer available. Choose another printing.",
          );
        const reason = blockedReason(card, flow.section, cards, flow.quantity);
        if (reason) throw new Error(reason);
        const result = await saveDeckToForge(
          draftFrom(
            target?.id ?? null,
            target?.name ?? flow.name,
            withCard(
              normalizePrintings(cards, card),
              card,
              flow.section,
              flow.quantity,
            ),
          ),
        );
        if (flow.targetId === id || flow.targetId === "draft")
          installDeck(result.deck, false);
        setAddFlow(null);
        onAddRequestHandled?.(flow.request.requestId);
        onChange();
        onAddComplete?.(
          `Added ${flow.quantity} ${flow.card.name} to "${result.deck.name}".`,
        );
        setNotice({
          kind: "success",
          message: `Added ${flow.quantity} ${flow.card.name} to “${result.deck.name}” and saved to Forge.`,
        });
        try {
          setDecks(await listDecks());
        } catch (error) {
          setNotice({
            kind: "info",
            message: `The cards were added and saved to Forge. The deck list could not refresh: ${errorMessage(error)}`,
          });
        }
      } catch (error) {
        setTargetError(errorMessage(error));
      }
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
  const targetCards =
    addFlow?.targetId === id || addFlow?.targetId === "draft"
      ? entries
      : addFlow?.targetId === "new"
        ? []
        : (targetDeck?.cards ?? []);
  const targetReason =
    addFlow && !targetLoading && !targetPrintingLoading
      ? blockedReason(
          addFlow.card,
          addFlow.section,
          targetCards,
          addFlow.quantity,
        )
      : null;
  const imageCacheDir = settings.forge.imageCacheDir;

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
            className="deck-dismiss"
            type="button"
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
            <p>Save this deck first, or discard the edits to continue.</p>
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
            <p>The saved deck and its managed Forge file will be removed.</p>
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
            This deck uses more copies than you own. Reduce their quantities
            before saving.
          </span>
        </div>
      )}
      <div
        className={`deck-workbench ${browserOpen ? "with-browser" : "browser-collapsed"}`}
      >
        <aside className="panel deck-library">
          <div className="panel-header">
            <h2 className="section-title">Decks</h2>
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
                <Loader2 size={15} className="animate-spin" /> Loading decks...
              </p>
            ) : !decks.length ? (
              <div className="deck-list-empty">
                <Swords size={25} strokeWidth={1.3} />
                <p>No saved decks yet.</p>
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
                    {deck.mainCount} main · {deck.sideboardCount} sideboard
                  </span>
                </button>
              ))
            )}
          </div>
        </aside>
        <section className="panel deck-workbench-editor" ref={editor}>
          <div className="deck-workbench-heading">
            <div className="field">
              <Label htmlFor="deck-name">
                Deck name{" "}
                {dirty && <span className="deck-unsaved">· Unsaved</span>}
              </Label>
              <Input
                id="deck-name"
                value={name}
                maxLength={100}
                onChange={(event) => setName(event.target.value)}
                disabled={!!busy}
              />
            </div>
            <div className="deck-workbench-actions">
              <Button
                size="sm"
                variant="outline"
                disabled={!!busy || !id || hasUnownedCards}
                onClick={() => id && requestAction({ kind: "duplicate", id })}
              >
                <Copy size={14} /> Copy deck
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
          <div className="deck-workbench-toolbar">
            <div
              className="deck-section-tabs"
              role="tablist"
              aria-label="Deck sections"
            >
              {(["main", "sideboard"] as const).map((item) => (
                <button
                  type="button"
                  role="tab"
                  id={`deck-tab-${item}`}
                  key={item}
                  aria-selected={section === item}
                  aria-controls="deck-card-list"
                  className={section === item ? "active" : ""}
                  onClick={() => {
                    setSection(item);
                  }}
                >
                  {item === "main" ? "Main deck" : "Sideboard"}{" "}
                  <span>
                    {item === "main"
                      ? mainCount
                      : `${sideboardCount} / ${settings.league.deckRestrictions.maximumSideboard}`}
                  </span>
                </button>
              ))}
            </div>
            <div className="deck-display-controls">
              <label className="deck-density-control">
                <span>Cards per row</span>
                <select
                  aria-label="Cards per row"
                  value={cardsPerRow}
                  onChange={(event) =>
                    setCardsPerRow(event.target.value as CardsPerRow)
                  }
                >
                  <option value="auto">Auto</option>
                  {[2, 3, 4, 5, 6].map((value) => (
                    <option value={value} key={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </label>
              <Button
                size="icon"
                variant="ghost"
                aria-label={
                  browserOpen ? "Hide card browser" : "Show card browser"
                }
                title={browserOpen ? "Hide card browser" : "Show card browser"}
                aria-expanded={browserOpen}
                aria-controls="deck-browser"
                onClick={() => setBrowserOpen((open) => !open)}
              >
                {browserOpen ? (
                  <PanelRightClose size={18} />
                ) : (
                  <PanelRightOpen size={18} />
                )}
              </Button>
            </div>
          </div>
          <div
            id="deck-card-list"
            className="deck-oracle-grid"
            style={{
              gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
            }}
            role="tabpanel"
            aria-labelledby={`deck-tab-${section}`}
          >
            {!groups.length ? (
              <div className="deck-workbench-empty">
                <Layers3 size={30} strokeWidth={1.1} />
                <h3>
                  {section === "main"
                    ? "Build your next deck."
                    : "Prepare your sideboard."}
                </h3>
                <p>
                  Add cards from the browser
                  {browserOpen ? "." : " by opening it with the button above."}
                </p>
              </div>
            ) : (
              groups.map((group) => {
                const card = group.card;
                const reason = blockedReason(card, section);
                return (
                  <article
                    className="deck-oracle-tile"
                    key={`${section}:${card.oracleId}`}
                  >
                    <div className="deck-oracle-art">
                      <CardImage card={card} imageCacheDir={imageCacheDir} />
                      <button
                        type="button"
                        className="card-art-trigger"
                        onClick={() => setSelectedCard(card)}
                        aria-label={`View ${card.name} details`}
                      />
                      <span className="deck-quantity-badge">
                        {group.quantity}
                      </span>
                    </div>
                    <div className="deck-oracle-copy">
                      <DeckCardTitle
                        card={card}
                        onDetails={() => setSelectedCard(card)}
                      />
                      <div className="deck-oracle-controls">
                        <Button
                          size="icon"
                          variant="ghost"
                          disabled={!!busy}
                          aria-label={`Remove one ${card.name} from ${section}`}
                          onClick={() => removeGroupCard(group)}
                        >
                          <Minus size={15} />
                        </Button>
                        <span
                          aria-label={`${group.quantity} copies in ${section}`}
                        >
                          {group.quantity}
                        </span>
                        <Button
                          size="icon"
                          variant="ghost"
                          disabled={!!busy || !!reason}
                          title={reason ?? "Add one copy"}
                          aria-label={`Add one ${card.name} to ${section}`}
                          onClick={() => changeCard(card, section, 1)}
                        >
                          <Plus size={15} />
                        </Button>
                      </div>
                    </div>
                  </article>
                );
              })
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
                {Object.keys(colorNames).map((key) => (
                  <span key={key} title={colorNames[key]}>
                    <i className={`mana-color mana-${key.toLowerCase()}`}>
                      {key}
                    </i>
                    <strong>
                      {entries
                        .filter(
                          (entry) =>
                            entry.section === "main" &&
                            (key === "C"
                              ? !entry.card.colors.length
                              : entry.card.colors.includes(key)),
                        )
                        .reduce((sum, entry) => sum + entry.quantity, 0)}
                    </strong>
                  </span>
                ))}
              </div>
            </div>
          </div>
          <div className="deck-validation" aria-live="polite">
            {checking ? (
              <p className="field-hint">
                <Loader2 size={14} className="animate-spin" /> Checking deck...
              </p>
            ) : validation?.warnings.length ? (
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
            ) : validation ? (
              <p className="deck-validation-ok">
                <CheckCircle2 size={15} /> Ready for Forge.
              </p>
            ) : (
              <p className="field-hint">
                Validation is unavailable. You can still save a draft.
              </p>
            )}
          </div>
          <div className="deck-save-bar">
            <Button
              size="sm"
              onClick={() => void handleSave()}
              disabled={
                !!busy || hasUnownedCards || !name.trim() || (!dirty && !!id)
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
        </section>
        {browserOpen && (
          <aside className="panel deck-browser" id="deck-browser">
            <div className="panel-header">
              <h2 className="section-title">
                Cards{" "}
                {pickerLoading && (
                  <Loader2
                    size={13}
                    className="animate-spin deck-browser-refreshing"
                    aria-label="Updating card results"
                  />
                )}
              </h2>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Hide card browser"
                onClick={() => setBrowserOpen(false)}
              >
                <PanelRightClose size={17} />
              </Button>
            </div>
            <div className="deck-browser-filters">
              <CardFilters
                query={effectiveQuery}
                onChange={(next) => setQuery({ ...next, page: 0 })}
                options={options}
                loading={pickerLoading}
                advancedCollapsible
              />
              <p className="field-hint">
                Adding to{" "}
                <strong>
                  {section === "main" ? "main deck" : "sideboard"}
                </strong>{" "}
                · {pickerTotal.toLocaleString()} available cards
              </p>
            </div>
            {pickerError && pickerCards.length > 0 && (
              <p className="deck-browser-query-error" role="alert">
                {pickerError}
              </p>
            )}
            <div className="deck-browser-grid" aria-busy={pickerLoading}>
              {!pickerHasResult && !pickerError ? (
                <div
                  className="deck-browser-initial"
                  aria-label="Loading available cards"
                >
                  {pickerLoading && (
                    <Loader2 size={16} className="animate-spin" />
                  )}
                </div>
              ) : pickerError && !pickerCards.length ? (
                <div className="deck-browser-empty" role="alert">
                  <AlertTriangle size={24} />
                  <p>{pickerError}</p>
                </div>
              ) : !availablePickerCards.length ? (
                <div className="deck-browser-empty">
                  <Layers3 size={27} />
                  <h3>
                    {catalogCount === 0
                      ? "Catalog setup is in progress."
                      : "No available cards match."}
                  </h3>
                  <p>
                    Try different filters, or open packs to expand your
                    collection.
                  </p>
                </div>
              ) : (
                availablePickerCards.map((original) => {
                  const chosen =
                    entries.find(
                      (entry) => entry.card.oracleId === original.oracleId,
                    )?.card ?? preferred[original.oracleId];
                  const card = chosen
                    ? {
                        ...chosen,
                        oracleOwned: ownedCount(original),
                        owned: chosen.owned,
                      }
                    : original;
                  const reason = blockedReason(card, section);
                  return (
                    <article className="deck-browser-card" key={card.oracleId}>
                      <div className="deck-oracle-art">
                        <CardImage card={card} imageCacheDir={imageCacheDir} />
                        <button
                          type="button"
                          className="card-art-trigger"
                          onClick={() => setSelectedCard(card)}
                          aria-label={`View ${card.name} details`}
                        />
                      </div>
                      <div className="deck-oracle-copy">
                        <DeckCardTitle
                          card={card}
                          onDetails={() => setSelectedCard(card)}
                        />
                        <div className="deck-browser-card-actions">
                          <Button
                            size="icon"
                            variant="secondary"
                            aria-label={`Add ${card.name} to ${section}`}
                            title={reason ?? "Add one copy"}
                            disabled={!!busy || !!reason}
                            onClick={() => changeCard(card, section, 1)}
                          >
                            <Plus size={16} />
                          </Button>
                        </div>
                      </div>
                    </article>
                  );
                })
              )}
            </div>
            {pickerTotal > pageSize && (
              <div className="deck-browser-pagination">
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Previous card page"
                  disabled={query.page === 0 || pickerLoading}
                  onClick={() =>
                    setQuery((current) => ({
                      ...current,
                      page: Math.max(0, current.page - 1),
                    }))
                  }
                >
                  <ChevronLeft size={16} />
                </Button>
                <span>
                  {query.page + 1} / {Math.ceil(pickerTotal / pageSize)}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Next card page"
                  disabled={
                    (query.page + 1) * pageSize >= pickerTotal || pickerLoading
                  }
                  onClick={() =>
                    setQuery((current) => ({
                      ...current,
                      page: current.page + 1,
                    }))
                  }
                >
                  <ChevronRight size={16} />
                </Button>
              </div>
            )}
          </aside>
        )}
      </div>
      {addFlow && (
        <DeckDialog title="Add to a deck" onClose={closeAddFlow}>
          <div className="deck-add-preview">
            <div>
              <CardImage card={addFlow.card} imageCacheDir={imageCacheDir} />
            </div>
            <div>
              <strong>{addFlow.card.name}</strong>
              <span>{addFlow.card.setName}</span>
              <Button
                variant="ghost"
                size="sm"
                disabled={!!busy || targetPrintingLoading}
                onClick={() => setSelectedCard(addFlow.card)}
              >
                Details
              </Button>
            </div>
          </div>
          <div className="field">
            <Label htmlFor="deck-add-target">Deck</Label>
            <select
              id="deck-add-target"
              value={addFlow.targetId}
              disabled={!!busy || targetPrintingLoading}
              onChange={(event) => {
                setTargetError(null);
                setAddFlow((flow) =>
                  flow ? { ...flow, targetId: event.target.value } : flow,
                );
              }}
            >
              <option value="new">Create a new deck</option>
              {id === null && dirty && (
                <option value="draft">Current draft: {name}</option>
              )}
              {decks.map((deck) => (
                <option key={deck.id} value={deck.id}>
                  {deck.name}
                  {deck.id === id && dirty ? " (current draft)" : ""}
                </option>
              ))}
            </select>
          </div>
          {addFlow.targetId === "new" && (
            <div className="field">
              <Label htmlFor="deck-add-name">Deck name</Label>
              <Input
                id="deck-add-name"
                value={addFlow.name}
                disabled={!!busy || targetPrintingLoading}
                maxLength={100}
                onChange={(event) => {
                  setTargetError(null);
                  setAddFlow((flow) =>
                    flow ? { ...flow, name: event.target.value } : flow,
                  );
                }}
              />
            </div>
          )}
          <div className="deck-add-controls">
            <div className="field">
              <Label htmlFor="deck-add-section">Section</Label>
              <select
                id="deck-add-section"
                value={addFlow.section}
                disabled={!!busy}
                onChange={(event) => {
                  setTargetError(null);
                  setAddFlow((flow) =>
                    flow
                      ? { ...flow, section: event.target.value as Section }
                      : flow,
                  );
                }}
              >
                <option value="main">Main deck</option>
                <option value="sideboard">Sideboard</option>
              </select>
            </div>
            <div className="field">
              <Label>Copies</Label>
              <div className="deck-printing-quantity">
                <Button
                  variant="outline"
                  size="icon"
                  aria-label="Add fewer copies"
                  disabled={!!busy || addFlow.quantity <= 1}
                  onClick={() => {
                    setTargetError(null);
                    setAddFlow((flow) =>
                      flow
                        ? { ...flow, quantity: Math.max(1, flow.quantity - 1) }
                        : flow,
                    );
                  }}
                >
                  <Minus size={14} />
                </Button>
                <strong>{addFlow.quantity}</strong>
                <Button
                  variant="outline"
                  size="icon"
                  aria-label="Add more copies"
                  disabled={
                    !!busy ||
                    !!blockedReason(
                      addFlow.card,
                      addFlow.section,
                      targetCards,
                      addFlow.quantity + 1,
                    )
                  }
                  onClick={() => {
                    setTargetError(null);
                    setAddFlow((flow) =>
                      flow ? { ...flow, quantity: flow.quantity + 1 } : flow,
                    );
                  }}
                >
                  <Plus size={14} />
                </Button>
              </div>
            </div>
          </div>
          {(addFlow.targetId === id || addFlow.targetId === "draft") &&
            dirty && (
              <p className="field-hint">
                Your current edits will be saved together with this card.
              </p>
            )}
          {targetLoading || targetPrintingLoading ? (
            <p className="field-hint">
              <Loader2 size={14} className="animate-spin" /> Checking this
              deck...
            </p>
          ) : (
            (targetError || targetReason) && (
              <div className="notice notice-error" role="alert">
                {targetError || targetReason}
              </div>
            )
          )}
          <div className="deck-dialog-footer">
            <Button variant="ghost" onClick={closeAddFlow} disabled={!!busy}>
              Cancel
            </Button>
            <Button
              onClick={() => void confirmCollectionAdd()}
              disabled={
                !!busy ||
                targetLoading ||
                targetPrintingLoading ||
                !!targetError ||
                !!targetReason ||
                (addFlow.targetId === "new" && !addFlow.name.trim())
              }
            >
              {busy === "collection-add" ? (
                <Loader2 size={15} className="animate-spin" />
              ) : (
                <Plus size={15} />
              )}{" "}
              {addFlow.targetId === "new" ? "Create and add" : "Add"}
            </Button>
          </div>
        </DeckDialog>
      )}
      {selectedCard && (
        <CardDetails
          card={selectedCard}
          imageCacheDir={imageCacheDir}
          league={league}
          onClose={() => setSelectedCard(null)}
          onChange={onChange}
          onPrintingChange={(card) => {
            setSelectedCard(card);
            if (addFlow) {
              setAddFlow((flow) =>
                flow ? { ...flow, card, printingExplicit: true } : flow,
              );
              setTargetError(null);
            } else {
              setPreferred((current) => ({
                ...current,
                [card.oracleId]: card,
              }));
              updateEntries((current) => normalizePrintings(current, card));
            }
          }}
        />
      )}
    </div>
  );
}
