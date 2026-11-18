import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

// Pointer hover and keyboard focus can land on different cards at the same time.
let dismissOpenPreview: (() => void) | undefined;

export function CardReading({
  name,
  art,
  manaCost,
  typeLine,
  oracleText,
  stats,
  damage,
  counters,
  details,
}: {
  name: string;
  art: ReactNode;
  manaCost?: string;
  typeLine?: string;
  oracleText?: string;
  stats?: string;
  damage?: number;
  counters?: Record<string, number>;
  details?: string[];
}) {
  return (
    <div className="pt-card-reading">
      <div className="pt-reading-image">{art}</div>
      <div className="pt-reading-rules">
        <strong>{name}</strong>
        {manaCost && <b>{manaCost}</b>}
        {typeLine && <span>{typeLine}</span>}
        {oracleText && <p>{oracleText}</p>}
        {details?.map((detail) => <span key={detail}>{detail}</span>)}
        {stats && <b>{stats}</b>}
        {!!damage && <span>{damage} damage marked</span>}
        {counters &&
          Object.entries(counters)
            .filter(([, count]) => count > 0)
            .map(([kind, count]) => (
              <span key={kind}>
                {count} {kind} {count === 1 ? "counter" : "counters"}
              </span>
            ))}
      </div>
    </div>
  );
}

export function PreviewAnchor({
  reading,
  className = "",
  children,
}: {
  reading: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const anchor = useRef<HTMLDivElement>(null);
  const bubble = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [shown, setShown] = useState(false);
  const tooltipId = useId();
  function schedule(show: boolean, delay: number) {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setShown(show), delay);
  }
  function hide() {
    clearTimeout(timer.current);
    setShown(false);
  }
  useEffect(() => () => clearTimeout(timer.current), []);
  useLayoutEffect(() => {
    if (!shown || !anchor.current || !bubble.current) return;
    dismissOpenPreview?.();
    dismissOpenPreview = hide;
    const target = anchor.current;
    const tip = bubble.current;
    const place = () => {
      const box = target.getBoundingClientRect();
      const gap = 8;
      const width = tip.offsetWidth;
      const height = tip.offsetHeight;
      let x = box.right + gap;
      let y = box.top + (box.height - height) / 2;
      if (x + width > window.innerWidth - gap) {
        if (box.left - gap >= width) x = box.left - width - gap;
        else {
          x = box.left;
          y =
            box.top >= height + gap ? box.top - height - gap : box.bottom + gap;
        }
      }
      tip.style.left =
        Math.max(gap, Math.min(x, window.innerWidth - width - gap)) + "px";
      tip.style.top =
        Math.max(gap, Math.min(y, window.innerHeight - height - gap)) + "px";
    };
    const dismiss = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        hide();
      }
    };
    place();
    const resize = new ResizeObserver(place);
    resize.observe(tip);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    window.addEventListener("keydown", dismiss, true);
    return () => {
      if (dismissOpenPreview === hide) dismissOpenPreview = undefined;
      resize.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("keydown", dismiss, true);
    };
  }, [shown]);

  return (
    <>
      <div
        className={className}
        ref={anchor}
        aria-describedby={shown ? tooltipId : undefined}
        onPointerEnter={(e) => {
          if (e.pointerType !== "touch") schedule(true, 310);
        }}
        onPointerLeave={(e) => {
          if (e.pointerType !== "touch") schedule(false, 160);
        }}
        onFocus={(e) => {
          if (
            !e.target.hasAttribute("data-auto-focus") &&
            e.target.matches(":focus-visible")
          )
            schedule(true, 310);
        }}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget)) hide();
        }}
      >
        {children}
      </div>
      {shown &&
        createPortal(
          <div
            ref={bubble}
            id={tooltipId}
            role="tooltip"
            className="pt-card-preview"
            onPointerEnter={() => clearTimeout(timer.current)}
            onPointerLeave={() => schedule(false, 160)}
          >
            {reading}
          </div>,
          anchor.current?.closest("dialog") ?? document.body,
        )}
    </>
  );
}

export function StackCardName({
  label,
  reading,
}: {
  label: string;
  reading: ReactNode;
}) {
  return (
    <PreviewAnchor reading={reading} className="pt-stack-card-name">
      <strong tabIndex={0}>{label}</strong>
    </PreviewAnchor>
  );
}
