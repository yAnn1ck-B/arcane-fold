import { Undo2 } from "lucide-react";
import type { HistoryEntry } from "./types";

interface SavedStep {
  revision: number;
  historyCount: number;
  turn: number;
  label: string;
}

interface LogRow extends HistoryEntry {
  key: string;
  step?: SavedStep;
}

function logRows(entries: HistoryEntry[], steps: SavedStep[]) {
  const rows: LogRow[] = [];
  let count = 0;
  for (const step of steps) {
    // Forge can publish several events before it next offers a decision.
    // Only the last event in that batch represents the saved board.
    if (step.historyCount > entries.length || step.historyCount < count) continue;
    if (step.historyCount === count) {
      rows.push({ key: `step-${step.revision}`, turn: step.turn, text: step.label, step });
    } else {
      while (count < step.historyCount) {
        rows.push({ ...entries[count], key: `event-${count}` });
        count++;
      }
      rows[rows.length - 1].step = step;
    }
  }
  while (count < entries.length) {
    rows.push({ ...entries[count], key: `event-${count}` });
    count++;
  }
  return rows.reverse();
}

export function GameHistory({ entries, steps = [], onUndo, disabled }: {
  entries: HistoryEntry[];
  steps?: SavedStep[];
  onUndo?: (revision: number) => void;
  disabled?: boolean;
}) {
  const rows = logRows(entries, steps);
  return (
    <div className="pt-panel-body">
      {rows.length ? (
        <ol className="pt-game-log" reversed>
          {rows.map(({ key, text, turn, step }, index) => (
            <li key={key}>
              {rows[index - 1]?.turn !== turn && (
                <h3>{turn > 0 ? `Turn ${turn}` : "Opening hands"}</h3>
              )}
              <div className="pt-log-entry">
                <span>{text}</span>
                {step && onUndo && (
                  <button type="button" className="pt-tool" disabled={disabled}
                    aria-label={`Request undo to step ${step.revision}: ${step.label}`}
                    data-hint="Request undo to this point" onClick={() => onUndo(step.revision)}>
                    <Undo2 size={15} aria-hidden />
                  </button>
                )}
              </div>
            </li>
          ))}
        </ol>
      ) : <p className="pt-empty">No game actions yet.</p>}
    </div>
  );
}
