import "@/styles/card-browser.css";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, LoaderCircle, X } from "lucide-react";
import CardImage from "@/components/CardImage";
import { Button } from "@/components/ui/button";
import { isUnlimitedBasic } from "@/lib/cards";
import { getCardPrintings } from "@/services/cards";
import type { CatalogCard } from "@/lib/types";

interface PrintingPickerProps {
  card: CatalogCard;
  imageCacheDir: string;
  currentCardId?: string;
  onSelect: (card: CatalogCard) => void;
  onClose: () => void;
  eligibleOnly?: boolean;
  disabled?: boolean;
}

/** Eligible globally unlocked printings share the card's pooled ownership budget. */
export default function PrintingPicker({
  card,
  imageCacheDir,
  currentCardId = card.id,
  onSelect,
  onClose,
  eligibleOnly = false,
  disabled = false,
}: PrintingPickerProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [printings, setPrintings] = useState<CatalogCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    getCardPrintings(card.oracleId)
      .then((items) => {
        if (active)
          setPrintings(
            items.filter(
              (printing) =>
                !eligibleOnly ||
                isUnlimitedBasic(printing) ||
                (printing.oracleOwned ?? printing.owned) > 0,
            ),
          );
      })
      .catch((reason: unknown) => {
        if (active) setError(String(reason));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [card.oracleId, eligibleOnly]);

  return createPortal(
    <dialog
      ref={dialog}
      className="printing-picker-dialog"
      aria-label={`Choose a printing of ${card.name}`}
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === dialog.current) onClose();
      }}
    >
      <div className="printing-picker-heading">
        <div>
          <h2>Choose a printing</h2>
          <p>
            {card.name}
            <span>
              {isUnlimitedBasic(card)
                ? "Unlimited basic land"
                : `${printings[0]?.oracleOwned ?? card.oracleOwned ?? card.owned} owned`}
            </span>
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Close printing picker"
          onClick={onClose}
        >
          <X size={18} />
        </Button>
      </div>
      {loading && (
        <p className="printing-picker-status" role="status">
          <LoaderCircle size={17} className="animate-spin" /> Loading
          printings...
        </p>
      )}
      {error && (
        <div className="notice notice-error" role="alert">
          {error}
        </div>
      )}
      {!loading && !error && !printings.length && (
        <p className="printing-picker-status">
          No printings are available in unlocked expansions.
        </p>
      )}
      <div className="printing-picker-grid">
        {printings.map((printing) => (
          <article
            key={printing.id}
            className={`printing-picker-option ${printing.id === currentCardId ? "selected" : ""}`}
            aria-disabled={disabled}
            onClick={() => {
              if (!disabled) onSelect(printing);
            }}
          >
            <div className="printing-picker-art">
              <CardImage card={printing} imageCacheDir={imageCacheDir} />
              {printing.id === currentCardId && (
                <span className="printing-selected-mark">
                  <Check size={15} /> Selected
                </span>
              )}
            </div>
            <button
              type="button"
              className="printing-picker-name"
              aria-label={`Use ${printing.setName} #${printing.collectorNumber} printing of ${printing.name}`}
              aria-pressed={printing.id === currentCardId}
              disabled={disabled}
              onClick={(event) => {
                event.stopPropagation();
                onSelect(printing);
              }}
            >
              {printing.setName}
            </button>
            <span>
              #{printing.collectorNumber}{" "}
              <i className={`rarity-dot rarity-${printing.rarity}`} />{" "}
              {printing.rarity}
            </span>
          </article>
        ))}
      </div>
    </dialog>,
    document.body,
  );
}
