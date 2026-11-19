import type { HistoryEntry } from "./types";

export function GameHistory({ entries }: { entries: HistoryEntry[] }) {
  const newestFirst = entries.slice().reverse();
  return (
    <div className="pt-panel-body">
      {newestFirst.length ? (
        <ol className="pt-game-log" reversed>
          {newestFirst.map((entry, index) => (
            <li key={newestFirst.length - 1 - index}>
              {newestFirst[index - 1]?.turn !== entry.turn && (
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
