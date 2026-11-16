import { formatMana } from "@/lib/mana";
import { useEffect, useRef, useState } from "react";
import { LoaderCircle, RotateCw, Sparkles, X } from "lucide-react";
import CardImage from "@/components/CardImage";
import { Button } from "@/components/ui/button";
import { getCard } from "@/services/cards";
import { craftCard } from "@/services/progression";
import { isUnlimitedBasic } from "@/lib/cards";
import type { CatalogCard, LeagueStatus, WildcardRarity } from "@/lib/types";

interface CardDetailsProps {
  card: CatalogCard;
  imageCacheDir: string;
  league: LeagueStatus;
  onClose: () => void;
  onChange: () => void;
}

/** Shared card dialog. History snapshots always refresh ownership. */
export default function CardDetails({
  card,
  imageCacheDir,
  league,
  onClose,
  onChange,
}: CardDetailsProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [current, setCurrent] = useState(card);
  const [face, setFace] = useState<"front" | "back">("front");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
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
    let active = true;
    setCurrent(card);
    setFace("front");
    setLoading(true);
    setLoadError(false);
    setError(null);
    setNotice(null);
    getCard(card.id)
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
  }, [card.id]);

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
    setNotice(null);
    try {
      const requestId =
        craftRequests.current.get(current.id) ?? crypto.randomUUID();
      craftRequests.current.set(current.id, requestId);
      await craftCard(current.id, requestId);
      craftRequests.current.delete(current.id);
      onChange();
      const fresh = await getCard(current.id);
      setCurrent(fresh);
      setNotice(`Crafted one ${fresh.name}.`);
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
    }
  }

  return (
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
        <div>
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
          <span className="eyebrow">
            {current.setName} · #{current.collectorNumber}
          </span>
          <h2>{current.name}</h2>
          <p className="card-detail-mana">
            {formatMana(current.manaCost) || "No mana cost"} · Mana value{" "}
            {current.cmc}
          </p>
          <p className="card-detail-type">{current.typeLine}</p>
          <p className="card-rules">
            {formatMana(current.oracleText) || "No rules text."}
          </p>
          <span className="badge badge-muted">
            {current.rarity.toUpperCase()} · {current.setCode.toUpperCase()}
          </span>
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
          {notice && (
            <p className="collection-notice" role="status">
              {notice}
            </p>
          )}
          {unlimited ? (
            <div className="craft-panel">
              <p>
                Unlimited for deck building. You can use these basic lands
                without collecting or crafting copies.
              </p>
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
              <p className="card-preview-owned">
                {current.owned} owned of this printing · {oracleOwned}/4 owned
                across all printings
              </p>
            </>
          )}
        </div>
      </div>
    </dialog>
  );
}
