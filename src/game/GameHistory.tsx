import { useLayoutEffect, useRef } from "react";
import type { HistoryEntry } from "./types";

export function GameHistory({ entries }: { entries: HistoryEntry[] }) {
  const scroller = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (scroller.current)
      scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [entries.length]);
  return (
    <div className="pt-panel-body" ref={scroller}>
      {entries.length ? (
        <ol className="pt-game-log">
          {entries.map((entry, index) => (
            <li key={index}>
              {entries[index - 1]?.turn !== entry.turn && (
                <h3>
                  {entry.turn > 0 ? `Turn ${entry.turn}` : "Opening hands"}
                </h3>
              )}
              {entry.text}
            </li>
          ))}
        </ol>
      ) : (
        <p className="pt-empty">No game actions yet.</p>
      )}
    </div>
  );
}
