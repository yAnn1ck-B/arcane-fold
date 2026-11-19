import { createContext, useContext, useEffect, useRef, useState } from "react";
import { ImageOff, RefreshCw } from "lucide-react";
import type { CatalogCard } from "@/lib/types";

type ImageCard = Pick<CatalogCard, "id" | "name"> & Partial<Pick<CatalogCard, "setCode" | "collectorNumber">>;
export const CardImageSource = createContext<((card: ImageCard, face: "front" | "back") => string) | undefined>(undefined);

export default function CardImage({
  card,
  className = "",
  face = "front",
}: {
  card: ImageCard;
  className?: string;
  face?: "front" | "back";
}) {
  const container = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [failedSource, setFailedSource] = useState<string>();
  const imageSource = useContext(CardImageSource);
  const source = imageSource?.(card, face) ?? `/api/art?${new URLSearchParams({ id: card.id, face })}`;
  const error = source === failedSource;

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

  return (
    <div ref={container} className={`card-image ${className}`}>
      {visible && !error ? (
        <img
          src={source}
          alt={face === "back" ? `${card.name} — back face` : card.name}
          loading="lazy"
          onError={() => setFailedSource(source)}
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
                setFailedSource(undefined);
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
