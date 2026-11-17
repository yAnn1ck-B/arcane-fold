import { formatMana } from "@/lib/mana";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Layers3,
  LoaderCircle,
  Plus,
  RotateCw,
  Sparkles,
  X,
} from "lucide-react";
import CardImage from "@/components/CardImage";
import PrintingPicker from "@/components/PrintingPicker";
import { useToast } from "@/components/ToastProvider";
import "@/styles/card-browser.css";
import { Button } from "@/components/ui/button";
import { getCard, getCardPrintings } from "@/services/cards";
import { craftCard } from "@/services/progression";
import { isUnlimitedBasic } from "@/lib/cards";
import type { CatalogCard, LeagueStatus, WildcardRarity } from "@/lib/types";

interface CardDetailsProps {
  card: CatalogCard;
  imageCacheDir: string;
  league: LeagueStatus;
  onClose: () => void;
  onChange: () => void;
  onAddToDeck?: (card: CatalogCard) => void;
  onPrintingChange?: (card: CatalogCard) => void;
}

/** Shared card dialog. History snapshots always refresh ownership. */
export default function CardDetails({
  card,
  imageCacheDir,
  league,
  onClose,
  onChange,
  onAddToDeck,
  onPrintingChange,
}: CardDetailsProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [requested, setRequested] = useState(card);
  const [current, setCurrent] = useState(card);
  const [choosingPrinting, setChoosingPrinting] = useState(false);
  const [printingError, setPrintingError] = useState(false);
  const [unlockedPrintingIds, setUnlockedPrintingIds] = useState<string[]>([]);
  const [printingRevision, setPrintingRevision] = useState(0);
  const enabledSetsKey = league.enabledSets
    .map((code) => code.toLowerCase())
    .sort()
    .join(",");
  const [face, setFace] = useState<"front" | "back">("front");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  const running = useRef(false);
  const craftRequests = useRef(new Map<string, string>());

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => {
      element?.close();
    };
  }, []);

  useEffect(() => {
    setRequested(card);
  }, [card.id]);

  useEffect(() => {
    let active = true;
    setCurrent(requested);
    setFace("front");
    setLoading(true);
    setLoadError(false);
    setError(null);
    getCard(requested.id)
      .then((fresh) => {
        if (active) {
          setCurrent(fresh);
        }
      })
      .catch((reason: unknown) => {
        if (active) {
          setLoadError(true);
          setError(`Could not refresh this printing: ${String(reason)}`);
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [requested.id]);

  useEffect(() => {
    let active = true;
    setUnlockedPrintingIds([]);
    setPrintingError(false);
    getCardPrintings(requested.oracleId)
      .then((printings) => {
        if (active) {
          setUnlockedPrintingIds(printings.map((printing) => printing.id));
        }
      })
      .catch(() => {
        if (active) setPrintingError(true);
      });
    return () => {
      active = false;
    };
  }, [requested.oracleId, printingRevision, enabledSetsKey]);

  const unlimited = isUnlimitedBasic(current);
  const oracleOwned = current.oracleOwned ?? current.owned;
  const atCollectionLimit = !unlimited && oracleOwned >= 4;
  const unlocked = league.enabledSets.some(
    (set) => set.toLowerCase() === current.setCode.toLowerCase(),
  );
  const craftable =
    !unlimited &&
    ["common", "uncommon", "rare", "mythic"].includes(current.rarity);
  const balance = craftable
    ? league.wildcards[current.rarity as WildcardRarity]
    : 0;
  async function craft() {
    if (running.current || atCollectionLimit) return;
    running.current = true;
    setBusy(true);
    setError(null);
    try {
      const requestId =
        craftRequests.current.get(current.id) ?? crypto.randomUUID();
      craftRequests.current.set(current.id, requestId);
      const result = await craftCard(current.id, requestId);
      craftRequests.current.delete(current.id);
      setCurrent(result.card);
      onChange();
      toast(`Crafted one ${result.card.name}.`);
      try {
        setCurrent(await getCard(current.id));
      } catch (reason) {
        setError(`The card was crafted, but its details could not refresh: ${String(reason)}`);
      }
    } catch (reason) {
      setError(String(reason));
      try {
        setCurrent(await getCard(current.id));
        onChange();
      } catch {
        /* Keep the original crafting error if ownership cannot be refreshed. */
      }
    } finally {
      running.current = false;
      setBusy(false);
      setPrintingRevision((revision) => revision + 1);
    }
  }

  return createPortal(
    <dialog
      ref={dialog}
      className="card-dialog"
      onCancel={onClose}
      onClick={(event) => {
        if (event.target === dialog.current) onClose();
      }}
      aria-label={`${current.name} details`}
    >
      <div className="card-dialog-layout">
        <div className="card-dialog-art-column">
          <CardImage card={current} imageCacheDir={imageCacheDir} face={face} />
          {current.backImageUri && (
            <Button
              variant="outline"
              onClick={() => setFace(face === "front" ? "back" : "front")}
            >
              <RotateCw size={15} /> Show {face === "front" ? "back" : "front"}{" "}
              face
            </Button>
          )}
          <div className="card-detail-art-printing">
            <div className="card-detail-printing-meta">
              <strong>{current.setName}</strong>
              <span>
                #{current.collectorNumber} - {current.rarity}
              </span>
            </div>
            {unlockedPrintingIds.length > 1 && (
              <Button
                className="card-detail-printing-button"
                variant="outline"
                size="sm"
                disabled={busy}
                aria-haspopup="dialog"
                aria-expanded={choosingPrinting}
                onClick={() => setChoosingPrinting(true)}
              >
                <Layers3 size={13} /> Printing
              </Button>
            )}
          </div>
          {printingError && (
            <p className="field-hint" role="alert">
              Could not load printings.
            </p>
          )}
        </div>
        <div className="card-dialog-copy">
          <Button
            className="dialog-close"
            size="icon"
            variant="ghost"
            onClick={onClose}
            aria-label="Close card details"
          >
            <X size={19} />
          </Button>
          <span className="eyebrow">Card details</span>
          <h2>{current.name}</h2>
          <p className="card-detail-mana">
            {formatMana(current.manaCost) || "No mana cost"} · Mana value{" "}
            {current.cmc}
          </p>
          <p className="card-detail-type">{current.typeLine}</p>
          <p className="card-rules">
            {formatMana(current.oracleText) || "No rules text."}
          </p>
          {loading && (
            <p className="field-hint card-detail-loading" role="status">
              <LoaderCircle size={14} className="animate-spin" /> Refreshing
              ownership…
            </p>
          )}
          {error && (
            <div className="notice notice-error" role="alert">
              {error}
            </div>
          )}
          {unlimited ? (
            <div className="craft-panel">
              <p>Unlimited basic land.</p>
            </div>
          ) : (
            <>
              <div className="craft-panel">
                <p>
                  {atCollectionLimit
                    ? "You have reached the four-copy limit across all printings. No more copies can be crafted."
                    : !unlocked
                      ? "This expansion has not unlocked in the shared league yet."
                      : !craftable
                        ? "This printing cannot be crafted with wildcards."
                        : `${balance} ${current.rarity} wildcards available`}
                </p>
                <Button
                  onClick={() => void craft()}
                  disabled={
                    busy ||
                    loading ||
                    loadError ||
                    !unlocked ||
                    !craftable ||
                    atCollectionLimit ||
                    balance < 1
                  }
                >
                  <Sparkles size={15} />{" "}
                  {atCollectionLimit
                    ? "Four-copy limit reached"
                    : `Craft one ${current.rarity} card`}
                </Button>
              </div>
              <p className="card-preview-owned">{oracleOwned} owned</p>
            </>
          )}
          {onAddToDeck && (
            <Button
              className="card-detail-add-deck"
              variant="outline"
              disabled={
                loading ||
                loadError ||
                busy ||
                !unlocked ||
                !unlockedPrintingIds.includes(current.id) ||
                (!unlimited && oracleOwned < 1)
              }
              onClick={() => onAddToDeck(current)}
            >
              <Plus size={15} /> Add to deck
            </Button>
          )}
        </div>
      </div>
      {choosingPrinting && (
        <PrintingPicker
          card={current}
          imageCacheDir={imageCacheDir}
          currentCardId={current.id}
          disabled={busy}
          onClose={() => setChoosingPrinting(false)}
          onSelect={(printing) => {
            setChoosingPrinting(false);
            setRequested(printing);
            onPrintingChange?.(printing);
          }}
        />
      )}
    </dialog>,
    document.body,
  );
}
