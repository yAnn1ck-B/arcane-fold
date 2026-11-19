import { createContext, useContext, useEffect, useRef, useState } from "react";
import { ImageOff, RefreshCw } from "lucide-react";
import type { CatalogCard } from "@/lib/types";
import { invalidateCardImage, resolveCardImage } from "@/services/cards";

type ImageCard = Pick<CatalogCard, "id" | "name"> & Partial<Pick<CatalogCard, "setCode" | "collectorNumber">>;
export const CardImageSource = createContext<((card: ImageCard, face: "front" | "back") => string) | undefined>(undefined);

export default function CardImage({
  card,
  imageCacheDir,
  className = "",
  face = "front",
}: {
  card: ImageCard;
  imageCacheDir: string;
  className?: string;
  face?: "front" | "back";
}) {
  const container = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [source, setSource] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const imageSource = useContext(CardImageSource);
  const provided = imageSource?.(card, face);

  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "160px" },
    );
    if (container.current) observer.observe(container.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    setSource(null);
    setError(false);
    (provided ? Promise.resolve(provided) : resolveCardImage(card.id, imageCacheDir, face))
      .then((url) => {
        if (!cancelled) setSource(url);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [card.id, imageCacheDir, face, visible, attempt, provided]);

  return (
    <div ref={container} className={`card-image ${className}`}>
      {source && !error ? (
        <img
          src={source}
          alt={face === "back" ? `${card.name} — back face` : card.name}
          loading="lazy"
          onError={() => {
            invalidateCardImage(card.id, imageCacheDir, face);
            setSource(null);
            setError(true);
          }}
        />
      ) : (
        <div className="card-image-placeholder">
          <ImageOff size={25} strokeWidth={1.2} />
          <span>{error ? "Artwork unavailable" : card.name}</span>
          {error && (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                invalidateCardImage(card.id, imageCacheDir, face);
                setAttempt((value) => value + 1);
              }}
              aria-label={`Retry artwork for ${card.name}`}
            >
              <RefreshCw size={13} /> Retry
            </button>
          )}
        </div>
      )}
    </div>
  );
}
