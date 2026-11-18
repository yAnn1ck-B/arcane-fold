import "@/styles/deck-browser.css";
import { formatMana } from "@/lib/mana";
import { appLifecycle } from "@/lib/app-lifecycle";
import { createPortal } from "react-dom";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
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
  Pencil,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import CardImage from "@/components/CardImage";
import CardDetails from "@/components/CardDetails";
import { useToast } from "@/components/ToastProvider";
import CardFilters, { getCardFilterScope } from "@/components/CardFilters";
import { isUnlimitedBasic } from "@/lib/cards";
import {
  CollectionAddBases,
  DeckAutosave,
  type DeckSaveAcknowledgement,
  type DeckSaveState,
} from "@/lib/deck-autosave";
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
  repairOnly?: boolean;
}
type Section = "main" | "sideboard";
type Notice = { kind: "error" | "info"; message: string };
type DeckAction = { kind: "load"; id: string };
type NewDeckPrompt = {
  mode: "new" | "current" | "copy";
  name: string;
  error: string | null;
  requestId: string;
  sourceId?: string;
};
type CollectionTarget = { id: string | null; name: string; cards: DeckEntry[] };
type CardGroup = { card: CatalogCard; entries: DeckEntry[]; quantity: number };
type CardsPerRow = "auto" | "2" | "3" | "4" | "5" | "6" | "7";
const densityStorageKey = "eternal-league.deck-cards-per-row";
function savedCardsPerRow(): CardsPerRow {
  try {
    const value = localStorage.getItem(densityStorageKey);
    if (value && ["auto", "2", "3", "4", "5", "6", "7"].includes(value))
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
function deckSummary(deck: DeckDetail): DeckSummary {
  return {
    id: deck.id,
    name: deck.name,
    createdAt: deck.createdAt,
    updatedAt: deck.updatedAt,
    mainCount: deck.cards
      .filter((card) => card.section === "main")
      .reduce((sum, card) => sum + card.quantity, 0),
    sideboardCount: deck.cards
      .filter((card) => card.section === "sideboard")
      .reduce((sum, card) => sum + card.quantity, 0),
  };
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
  disabled = false,
}: {
  card: CatalogCard;
  onDetails: () => void;
  disabled?: boolean;
}) {
  const mana = formatMana(card.manaCost);
  return (
    <div className="deck-card-title-row">
      <button
        type="button"
        className="deck-oracle-name"
        title={card.name}
        onClick={onDetails}
        disabled={disabled}
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
  className = "",
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  className?: string;
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
      className={`deck-dialog ${className}`}
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
  repairOnly = false,
}: DeckBuilderProps) {
  const toast = useToast();
  const exitState = useSyncExternalStore(
    appLifecycle.subscribe,
    appLifecycle.getSnapshot,
  );
  const [decks, setDecks] = useState<DeckSummary[]>([]);
  const [loadingDecks, setLoadingDecks] = useState(true);
  const [id, setId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const latestName = useRef("");
  const [newDeckPrompt, setNewDeckPrompt] = useState<NewDeckPrompt | null>(
    null,
  );
  const [renameValue, setRenameValue] = useState<string | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [entries, setEntries] = useState<DeckEntry[]>([]);
  const latestEntries = useRef<DeckEntry[]>([]);
  const [saveState, setSaveState] = useState<DeckSaveState>({
    phase: "idle",
    pending: false,
    error: null,
  });
  const saveEvents = useRef<(ack: DeckSaveAcknowledgement) => void>(() => {});
  const deckListRequest = useRef(0);
  const [autosave] = useState(
    () =>
      new DeckAutosave(
        async (snapshot, requestId) =>
          (await saveDeckToForge(snapshot, requestId)).deck,
        setSaveState,
        (ack) => saveEvents.current(ack),
      ),
  );
  const [section, setSection] = useState<Section>("main");
  const [taskBusy, setBusy] = useState<string | null>(null);
  const busy = taskBusy ?? (exitState.busy ? "exit" : null);
  const taskRunning = useRef(false);
  const activeTask = useRef<Promise<void> | null>(null);
  const activeTaskName = useRef<string | null>(null);
  const taskFailure = useRef<{ task: string; message: string } | null>(null);
  const prepareForExit = useRef<() => Promise<void>>(async () => {});
  useEffect(() => appLifecycle.register(() => prepareForExit.current()), []);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeckSummary | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [validation, setValidation] = useState<DeckValidation | null>(null);
  const [checking, setChecking] = useState(false);
  const validationRequest = useRef(0);
  const [selectedCard, setSelectedCard] = useState<CatalogCard | null>(null);
  const [browserOpen, setBrowserOpen] = useState(true);
  const [cardsPerRow, setCardsPerRow] = useState<CardsPerRow>(savedCardsPerRow);
  const [editorWidth, setEditorWidth] = useState(0);
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
  const [collectionBases] = useState(
    () => new CollectionAddBases<CollectionTarget | null>(),
  );
  const draft = useMemo(
    () => draftFrom(id, name, entries),
    [id, name, entries],
  );
  const dirty = saveState.pending;
  saveEvents.current = ({ deck }) => {
    if (
      taskFailure.current &&
      ["rename", "retry"].includes(taskFailure.current.task)
    )
      taskFailure.current = null;
    // Acknowledgements update identity/list metadata, never the current card edits.
    setId(deck.id);
    setAddFlow((current) =>
      current?.targetId === "draft"
        ? { ...current, targetId: deck.id }
        : current,
    );
    deckListRequest.current++;
    setDecks((current) => [
      deckSummary(deck),
      ...current.filter((item) => item.id !== deck.id),
    ]);
    onChange();
  };
  prepareForExit.current = async () => {
    // The global lock prevents another confirmed action from starting while we wait.
    await activeTask.current;
    if (taskFailure.current) throw new Error(taskFailure.current.message);
    const current = autosave.getDraft();
    if (!current.name.trim() && current.cards.length) {
      promptForNewDeck("current", true);
      throw new Error(
        "Name the pending deck or cancel its proposed edits before leaving.",
      );
    }
    try {
      await autosave.flush();
    } catch (error) {
      setNotice({ kind: "error", message: errorMessage(error) });
      throw error;
    }
  };
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
  const columns =
    cardsPerRow === "auto"
      ? // Favor another card at borderline widths, including scaled laptop displays.
        Math.max(
          1,
          Math.min(Math.ceil((editorWidth - 20) / 182), browserOpen ? 5 : 7),
        )
      : Number(cardsPerRow);
  const availablePickerCards = pickerCards.filter(
    (card) =>
      isUnlimitedBasic(card) ||
      (allocated[card.oracleId] ?? 0) < ownedCount(card),
  );
  function updateEntries(
    update: DeckEntry[] | ((current: DeckEntry[]) => DeckEntry[]),
    persist = true,
  ) {
    const next =
      typeof update === "function" ? update(latestEntries.current) : update;
    const normalized = normalizePrintings(next);
    latestEntries.current = normalized;
    setEntries(normalized);
    if (persist) {
      const changed = autosave.edit(
        draftFrom(autosave.getDraft().id, latestName.current, normalized),
      );
      if (changed && !latestName.current.trim()) promptForNewDeck("current");
    }
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
      if (entry.contentRect.width > 0) setEditorWidth(entry.contentRect.width);
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
        updateEntries(
          (current) =>
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
          false,
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
    const request = ++deckListRequest.current;
    setLoadingDecks(true);
    listDecks()
      .then((result) => {
        if (active && request === deckListRequest.current) setDecks(result);
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
    setValidation(null);
    if (!draft.name.trim()) {
      setChecking(false);
      return;
    }
    setChecking(true);
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
    collectionBases.clear();
    const current = autosave.getDraft();
    setAddFlow({
      request: addRequest,
      targetId:
        current.id ??
        (current.name.trim() || current.cards.length
          ? "draft"
          : (decks[0]?.id ?? "new")),
      name: "",
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
        const current = autosave.getDraft();
        setDecks((previous) => {
          const selected = previous.find((deck) => deck.id === current.id);
          return selected
            ? [
                selected,
                ...availableDecks.filter((deck) => deck.id !== selected.id),
              ]
            : availableDecks;
        });
        setAddFlow((flow) =>
          flow?.request.requestId === addRequest.requestId
            ? {
                ...flow,
                targetId:
                  current.id ??
                  (current.name.trim() || current.cards.length
                    ? "draft"
                    : (availableDecks[0]?.id ?? "new")),
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
    autosave.reset(draftFrom(deck.id, deck.name, deck.cards));
    setId(deck.id);
    latestName.current = deck.name;
    setName(deck.name);
    updateEntries(deck.cards, false);
    setSelectedCard(null);
    setPreferred({});
    setDecks((current) => [
      deckSummary(deck),
      ...current.filter((item) => item.id !== deck.id),
    ]);
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
    autosave.reset(draftFrom(null, "", []));
    setId(null);
    latestName.current = "";
    setName("");
    updateEntries([], false);
    setSelectedCard(null);
    setPreferred({});
    setNotice(null);
    setSection("main");
    setQuery((current) => ({ ...current, colors: [], color: "", page: 0 }));
  }
  function rememberTaskError(error: unknown) {
    const message = errorMessage(error);
    taskFailure.current = { task: activeTaskName.current ?? "deck", message };
    return message;
  }
  function clearTaskFailure(...tasks: string[]) {
    if (taskFailure.current && tasks.includes(taskFailure.current.task))
      taskFailure.current = null;
  }
  async function runTask(task: string, action: () => Promise<void>) {
    if (taskRunning.current || appLifecycle.isLocked()) return;
    taskRunning.current = true;
    activeTaskName.current = task;
    taskFailure.current = null;
    setBusy(task);
    setNotice(null);
    const work = (async () => {
      try {
        await action();
      } catch (error) {
        setNotice({ kind: "error", message: rememberTaskError(error) });
      } finally {
        taskRunning.current = false;
        activeTaskName.current = null;
        setBusy(null);
      }
    })();
    activeTask.current = work;
    await work;
    if (activeTask.current === work) activeTask.current = null;
  }

  async function performAction(action: DeckAction) {
    await runTask(action.kind, async () => {
      await autosave.flush();
      const deck = await loadDeck(action.id);
      installDeck(deck);
    });
  }
  function requestAction(action: DeckAction) {
    if (
      repairOnly ||
      taskRunning.current ||
      appLifecycle.isLocked() ||
      (action.kind === "load" && action.id === autosave.getDraft().id)
    )
      return;
    void performAction(action);
  }
  function promptForNewDeck(mode: "new" | "current", duringExit = false) {
    const currentDraft = autosave.getDraft();
    if (
      repairOnly &&
      (mode === "new" ||
        (!currentDraft.name.trim() && !currentDraft.cards.length))
    )
      return;
    if (appLifecycle.isLocked() && !duringExit) return;
    setNewDeckPrompt(
      (current) =>
        current ?? {
          mode,
          name: "",
          error: null,
          requestId: crypto.randomUUID(),
        },
    );
  }
  function promptForCopy() {
    const sourceId = autosave.getDraft().id;
    if (
      repairOnly ||
      !sourceId ||
      taskRunning.current ||
      appLifecycle.isLocked()
    )
      return;
    const suffix = " (copy)";
    setNewDeckPrompt({
      mode: "copy",
      name: `${latestName.current.slice(0, 100 - suffix.length).trimEnd()}${suffix}`,
      error: null,
      requestId: crypto.randomUUID(),
      sourceId,
    });
  }
  function closeNewDeck() {
    if (taskRunning.current || appLifecycle.isLocked()) return;
    // Canceling the first creation also cancels its proposed, still-unnamed edits.
    if (
      newDeckPrompt?.mode === "current" &&
      !autosave.getDraft().id &&
      !latestName.current.trim()
    )
      resetDeck();
    clearTaskFailure("new", "copy");
    setNewDeckPrompt(null);
  }
  async function createNamedDeck() {
    if (!newDeckPrompt || taskRunning.current || appLifecycle.isLocked())
      return;
    const prompt = newDeckPrompt;
    const nextName = prompt.name.trim();
    if (!nextName || nextName.length > 100) return;
    await runTask(prompt.mode === "copy" ? "copy" : "new", async () => {
      try {
        if (prompt.mode === "current") {
          latestName.current = nextName;
          setName(nextName);
          autosave.edit(
            draftFrom(autosave.getDraft().id, nextName, latestEntries.current),
            true,
          );
          await autosave.flush();
        } else {
          await autosave.flush();
          const cards =
            prompt.mode === "copy" && prompt.sourceId
              ? (await loadDeck(prompt.sourceId)).cards
              : [];
          const result = await saveDeckToForge(
            draftFrom(null, nextName, cards),
            prompt.requestId,
          );
          installDeck(result.deck);
          onChange();
        }
        setNewDeckPrompt(null);
        toast(
          prompt.mode === "copy"
            ? "Deck copied and saved to Forge."
            : "Deck created and saved to Forge.",
        );
      } catch (error) {
        const message = rememberTaskError(error);
        setNewDeckPrompt((current) =>
          current ? { ...current, error: message } : current,
        );
      }
    });
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
    if (
      (repairOnly && delta > 0) ||
      taskRunning.current ||
      appLifecycle.isLocked() ||
      !Number.isSafeInteger(delta)
    )
      return false;
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
  function closeRename() {
    if (taskRunning.current || appLifecycle.isLocked()) return;
    clearTaskFailure("rename");
    setRenameValue(null);
    setRenameError(null);
  }
  async function handleRename() {
    if (renameValue === null || taskRunning.current || appLifecycle.isLocked())
      return;
    const nextName = renameValue.trim();
    if (!nextName || nextName.length > 100) {
      setRenameError("Enter a deck name from 1 to 100 characters.");
      return;
    }
    if (nextName === name && !saveState.pending) {
      closeRename();
      return;
    }
    await runTask("rename", async () => {
      try {
        latestName.current = nextName;
        setName(nextName);
        autosave.edit(
          draftFrom(autosave.getDraft().id, nextName, latestEntries.current),
        );
        await autosave.flush();
        setRenameValue(null);
        setRenameError(null);
        toast("Deck renamed and saved to Forge.");
      } catch (error) {
        setRenameError(rememberTaskError(error));
      }
    });
  }
  async function handleDelete() {
    if (!deleteTarget) return;
    const target = deleteTarget;
    await runTask("delete", async () => {
      setDeleteError(null);
      await autosave.suspend();
      try {
        await deleteDeck(target.id);
        resetDeck();
        deckListRequest.current++;
        setDecks((current) => current.filter((deck) => deck.id !== target.id));
        onChange();
        toast(`Deleted "${target.name}" and its Forge file.`);
      } catch (error) {
        autosave.resume();
        setDeleteError(rememberTaskError(error));
      }
    });
  }
  function closeDelete() {
    if (taskRunning.current || appLifecycle.isLocked()) return;
    clearTaskFailure("delete");
    setDeleteTarget(null);
    setDeleteError(null);
  }
  function closeAddFlow() {
    if (taskRunning.current || appLifecycle.isLocked()) return;
    if (addFlow) onAddRequestHandled?.(addFlow.request.requestId);
    clearTaskFailure("collection-add", "collection-target");
    setAddFlow(null);
    setTargetError(null);
    collectionBases.clear();
  }
  async function changeAddTarget(targetId: string) {
    if (taskRunning.current || appLifecycle.isLocked()) return;
    await runTask("collection-target", async () => {
      try {
        await autosave.flush();
        setTargetError(null);
        setAddFlow((flow) => (flow ? { ...flow, targetId } : flow));
      } catch (error) {
        setTargetError(rememberTaskError(error));
      }
    });
  }
  async function confirmCollectionAdd() {
    if (!addFlow) return;
    const flow = addFlow;
    if (
      flow.targetId === "new" &&
      (!flow.name.trim() || flow.name.trim().length > 100)
    ) {
      setTargetError("Enter a deck name from 1 to 100 characters.");
      return;
    }
    await runTask("collection-add", async () => {
      setTargetError(null);
      try {
        await autosave.flush();
        const current = autosave.getDraft();
        const isCurrent =
          flow.targetId === "draft" || flow.targetId === current.id;
        const targetId =
          flow.targetId === "draft" ? (current.id ?? "draft") : flow.targetId;
        let target = collectionBases.get(flow.request.requestId, targetId);
        if (target === undefined) {
          const loaded =
            flow.targetId === "new"
              ? null
              : isCurrent
                ? {
                    id: current.id,
                    name: current.name,
                    cards: latestEntries.current,
                  }
                : await loadDeck(flow.targetId);
          target = collectionBases.capture(
            flow.request.requestId,
            targetId,
            loaded,
          );
        }
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
        // Derive edited retries from the original contents, never an ambiguous commit.
        const next = draftFrom(
          target?.id ?? null,
          flow.targetId === "new" ? flow.name.trim() : target!.name,
          withCard(
            normalizePrintings(cards, card),
            card,
            flow.section,
            flow.quantity,
          ),
        );
        const result = await saveDeckToForge(
          next,
          next.id ? undefined : flow.request.requestId,
        );
        if (isCurrent) installDeck(result.deck, false);
        collectionBases.clear();
        setAddFlow(null);
        onAddRequestHandled?.(flow.request.requestId);
        onChange();
        try {
          setDecks(await listDecks());
        } catch (error) {
          setNotice({
            kind: "info",
            message: `The cards were added and saved to Forge. The deck list could not refresh: ${errorMessage(error)}`,
          });
        }
      } catch (error) {
        setTargetError(rememberTaskError(error));
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
  let basicLands = 0;
  let nonbasicLands = 0;
  let landOptions = 0;
  let manaSources = 0;
  const sourcesByMana: Record<string, number> = {};
  for (const { card, section, quantity } of entries) {
    if (section !== "main") continue;

    const [front = "", back = ""] = card.typeLine.split(" // ");
    if (isUnlimitedBasic({ typeLine: front })) basicLands += quantity;
    else if (/\bLand\b/i.test(front.split(/[\u2014\u2013]/, 1)[0])) nonbasicLands += quantity;
    else if (/\bLand\b/i.test(back.split(/[\u2014\u2013]/, 1)[0])) landOptions += quantity;

    const produced = new Set(
      (card.producedMana ?? []).filter((mana) => Object.hasOwn(colorNames, mana)),
    );
    if (produced.size) manaSources += quantity;
    for (const mana of produced)
      sourcesByMana[mana] = (sourcesByMana[mana] ?? 0) + quantity;
  }
  const addTargetId =
    addFlow?.targetId === "draft"
      ? (autosave.getDraft().id ?? "draft")
      : addFlow?.targetId;
  const capturedTarget =
    addFlow && addTargetId
      ? collectionBases.get(addFlow.request.requestId, addTargetId)
      : undefined;
  const targetCards =
    capturedTarget !== undefined
      ? (capturedTarget?.cards ?? [])
      : addFlow?.targetId === id || addFlow?.targetId === "draft"
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
          <AlertTriangle size={17} />
          <span>{notice.message}</span>
          <button
            className="deck-dismiss"
            type="button"
            onClick={() => {
              taskFailure.current = null;
              setNotice(null);
            }}
            aria-label="Dismiss deck message"
          >
            <X size={15} />
          </button>
        </div>
      )}
      {saveState.error && (
        <div className="notice notice-error deck-autosave-error" role="alert">
          <AlertTriangle size={17} />
          <span>Changes have not been saved: {saveState.error}</span>
          <Button
            variant="outline"
            size="sm"
            disabled={!!busy}
            onClick={() => {
              void runTask("retry", () => autosave.flush());
            }}
          >
            Retry saving
          </Button>
        </div>
      )}
      {hasUnownedCards && (
        <div className="notice notice-error" role="alert">
          <AlertTriangle size={17} />
          <span>
            This deck uses more copies than you own. Reduce their quantities so
            automatic saving can continue.
          </span>
        </div>
      )}
      <div
        className={`deck-workbench ${browserOpen ? "with-browser" : "browser-collapsed"}`}
      >
        <section className="panel deck-workbench-editor" ref={editor}>
          <div className="deck-workbench-heading">
            <div
              className="deck-heading-selection"
              role="group"
              aria-label="Deck selection"
            >
              <div className="deck-library-selector">
                <Label htmlFor="deck-saved-selection">Deck</Label>
                <select
                  id="deck-saved-selection"
                  value={id ?? ""}
                  title={name || "Choose or create a deck"}
                  aria-busy={loadingDecks}
                  disabled={
                    repairOnly || loadingDecks || !!busy || !decks.length
                  }
                  onChange={(event) =>
                    requestAction({ kind: "load", id: event.target.value })
                  }
                >
                  {id === null && (
                    <option value="" disabled>
                      {name || "Choose or create a deck"}
                    </option>
                  )}
                  {id !== null && !decks.some((deck) => deck.id === id) && (
                    <option value={id}>{name}</option>
                  )}
                  {decks.map((deck) => (
                    <option key={deck.id} value={deck.id}>
                      {deck.id === id ? name : deck.name}
                    </option>
                  ))}
                </select>
              </div>
              <Button
                size="icon"
                variant="ghost"
                title="Rename deck"
                aria-label="Rename deck"
                disabled={!!busy || (repairOnly && !name.trim() && !dirty)}
                onClick={() => {
                  if (!latestName.current.trim()) {
                    promptForNewDeck("current");
                    return;
                  }
                  setRenameValue(name);
                  setRenameError(null);
                }}
              >
                <Pencil size={15} />
              </Button>
            </div>
            <div className="deck-workbench-actions">
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  promptForNewDeck(
                    latestName.current.trim() ? "new" : "current",
                  )
                }
                disabled={repairOnly || !!busy}
              >
                <Plus size={15} /> New deck
              </Button>
              <Button
                size="icon"
                variant="ghost"
                title="Copy deck"
                aria-label="Copy deck"
                disabled={repairOnly || !!busy || !id || hasUnownedCards}
                onClick={promptForCopy}
              >
                <Copy size={16} />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                aria-label="Delete saved deck"
                title="Delete saved deck"
                disabled={repairOnly || !!busy || !selectedSummary}
                onClick={() => {
                  if (repairOnly) return;
                  setDeleteError(null);
                  if (selectedSummary)
                    setDeleteTarget({ ...selectedSummary, name });
                }}
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
                  {[2, 3, 4, 5, 6, 7].map((value) => (
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
              gridTemplateColumns: `repeat(${columns}, minmax(${cardsPerRow === "auto" ? "0" : "110px"}, 1fr))`,
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
                        disabled={repairOnly}
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
                        disabled={repairOnly}
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
                          disabled={repairOnly || !!busy || !!reason}
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
          <section className="deck-analytics" aria-label="Main deck mana base">
            <div className="deck-land-count">
              <span className="eyebrow">LANDS</span>
              <p>
                <strong>{basicLands + nonbasicLands} / {mainCount}</strong>{" "}
                main deck cards
              </p>
              <p>{basicLands} basic · {nonbasicLands} nonbasic</p>
              {landOptions > 0 && <p>{landOptions} with a land on the back</p>}
            </div>
            <div className="deck-colors">
              <span className="eyebrow">MANA SOURCES · {manaSources} CARDS</span>
              <div>
                {Object.entries(colorNames).map(([key, label]) => (
                  <span key={key} title={label}>
                    <i
                      className={`mana-color mana-${key.toLowerCase()}`}
                      aria-label={label}
                    >
                      {key}
                    </i>
                    <strong>{sourcesByMana[key] ?? 0}</strong>
                  </span>
                ))}
              </div>
              <p>Includes nonland sources. Cards can count toward multiple mana types.</p>
            </div>
          </section>
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
                  const unlimited = isUnlimitedBasic(card);
                  const remaining = Math.max(
                    0,
                    ownedCount(card) - (allocated[card.oracleId] ?? 0),
                  );
                  const reason = blockedReason(card, section);
                  return (
                    <article className="deck-browser-card" key={card.oracleId}>
                      <div className="deck-oracle-art">
                        <CardImage card={card} imageCacheDir={imageCacheDir} />
                        <button
                          type="button"
                          className="card-art-trigger"
                          disabled={repairOnly}
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
                          <span
                            className="deck-browser-card-remaining"
                            title={unlimited ? "Unlimited basic land copies" : "Owned copies remaining"}
                          >
                            {unlimited ? "∞" : remaining}
                          </span>
                          <Button
                            size="icon"
                            variant="secondary"
                            aria-label={`Add ${card.name} to ${section}`}
                            title={reason ?? "Add one copy"}
                            disabled={repairOnly || !!busy || !!reason}
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
      {deleteTarget && (
        <DeckDialog
          title="Delete deck"
          className="deck-rename-dialog"
          onClose={closeDelete}
        >
          <p className="deck-dialog-copy">
            Delete <strong>{deleteTarget.name}</strong>? The saved deck and its
            managed Forge file will be removed.
          </p>
          {deleteError && (
            <div className="notice notice-error" role="alert">
              {deleteError}
            </div>
          )}
          <div className="deck-dialog-footer">
            <Button
              type="button"
              variant="ghost"
              onClick={closeDelete}
              disabled={!!busy}
              autoFocus
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => void handleDelete()}
              disabled={!!busy}
            >
              {busy === "delete" && (
                <Loader2 size={14} className="animate-spin" />
              )}{" "}
              Delete deck
            </Button>
          </div>
        </DeckDialog>
      )}
      {newDeckPrompt && (
        <DeckDialog
          title={newDeckPrompt.mode === "copy" ? "Copy deck" : "New deck"}
          className="deck-rename-dialog"
          onClose={closeNewDeck}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void createNamedDeck();
            }}
          >
            <div className="field">
              <Label htmlFor="deck-new-name">Deck name</Label>
              <Input
                id="deck-new-name"
                value={newDeckPrompt.name}
                maxLength={100}
                required
                autoFocus
                disabled={!!busy}
                aria-invalid={!!newDeckPrompt.error}
                aria-describedby={
                  newDeckPrompt.error ? "deck-new-error" : undefined
                }
                onChange={(event) =>
                  setNewDeckPrompt((current) =>
                    current
                      ? { ...current, name: event.target.value, error: null }
                      : current,
                  )
                }
              />
            </div>
            {newDeckPrompt.error && (
              <div
                id="deck-new-error"
                className="notice notice-error"
                role="alert"
              >
                {newDeckPrompt.error}
              </div>
            )}
            <div className="deck-dialog-footer">
              <Button
                type="button"
                variant="ghost"
                onClick={closeNewDeck}
                disabled={!!busy}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={
                  !!busy ||
                  !newDeckPrompt.name.trim() ||
                  newDeckPrompt.name.trim().length > 100
                }
              >
                {(busy === "new" || busy === "copy") && (
                  <Loader2 size={14} className="animate-spin" />
                )}{" "}
                {newDeckPrompt.mode === "copy" ? "Create copy" : "Create deck"}
              </Button>
            </div>
          </form>
        </DeckDialog>
      )}
      {renameValue !== null && (
        <DeckDialog
          title="Rename deck"
          className="deck-rename-dialog"
          onClose={closeRename}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void handleRename();
            }}
          >
            <div className="field">
              <Label htmlFor="deck-rename-name">Deck name</Label>
              <Input
                id="deck-rename-name"
                value={renameValue}
                maxLength={100}
                required
                autoFocus
                disabled={!!busy}
                aria-invalid={!!renameError}
                aria-describedby={renameError ? "deck-rename-error" : undefined}
                onFocus={(event) => event.target.select()}
                onChange={(event) => {
                  setRenameValue(event.target.value);
                  setRenameError(null);
                }}
              />
            </div>
            {renameError && (
              <div
                id="deck-rename-error"
                className="notice notice-error"
                role="alert"
              >
                {renameError}
              </div>
            )}
            <div className="deck-dialog-footer">
              <Button
                type="button"
                variant="ghost"
                onClick={closeRename}
                disabled={!!busy}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={
                  !!busy ||
                  !renameValue.trim() ||
                  renameValue.trim().length > 100
                }
              >
                {busy === "rename" && (
                  <Loader2 size={14} className="animate-spin" />
                )}
                Rename
              </Button>
            </div>
          </form>
        </DeckDialog>
      )}
      {addFlow && (
        <DeckDialog title="Add to a deck" onClose={closeAddFlow}>
          <div className="deck-add-layout">
            <div className="deck-add-art">
              <CardImage card={addFlow.card} imageCacheDir={imageCacheDir} />
            </div>
            <div className="deck-add-fields">
              <div className="deck-add-card-heading">
                <strong>{addFlow.card.name}</strong>
              </div>
              <div className="field">
                <Label htmlFor="deck-add-target">Deck</Label>
                <select
                  id="deck-add-target"
                  value={addFlow.targetId}
                  disabled={!!busy || targetPrintingLoading}
                  onChange={(event) => void changeAddTarget(event.target.value)}
                >
                  <option value="new">Create a new deck</option>
                  {id === null && dirty && (
                    <option value="draft">Current draft: {name}</option>
                  )}
                  {id !== null && !decks.some((deck) => deck.id === id) && (
                    <option value={id}>{name}</option>
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
                    required
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
                            ? {
                                ...flow,
                                quantity: Math.max(1, flow.quantity - 1),
                              }
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
                        repairOnly ||
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
                          flow
                            ? { ...flow, quantity: flow.quantity + 1 }
                            : flow,
                        );
                      }}
                    >
                      <Plus size={14} />
                    </Button>
                  </div>
                </div>
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
      {selectedCard && !repairOnly && (
        <CardDetails
          card={selectedCard}
          imageCacheDir={imageCacheDir}
          league={league}
          onClose={() => setSelectedCard(null)}
          onChange={onChange}
          onPrintingChange={(card) => {
            if (repairOnly || taskRunning.current || appLifecycle.isLocked())
              return;
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
