import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { prioritySteps, type PriorityStop, type PriorityWindow } from "./forge-match";
import { TableDialog } from "./TableDialog";

const windows = Object.keys(prioritySteps) as PriorityWindow[];
const turns = ["own", "opponent"] as const;

export interface PriorityStopSettings {
  stops: PriorityStop; opponentName: string; locked: boolean; error?: ReactNode;
  onSave: (selection: PriorityStop) => Promise<boolean>;
}

export function PriorityStopsDialog({ stops, opponentName, locked, error, onSave, onClose }: PriorityStopSettings & { onClose: () => void }) {
  const [draft, setDraft] = useState<PriorityStop>(() => {
    // A browser refresh can pick up the new UI before its host has restarted.
    const editable = (saved: string[]) => saved.includes("every") ? [...windows] : windows.filter(step => saved.includes(step));
    return {own: editable(stops.own), opponent: editable(stops.opponent)};
  });
  const [saving, setSaving] = useState(false);
  const selectedCount = draft.own.length + draft.opponent.length;
  function toggle(turn: keyof PriorityStop, step: PriorityWindow, checked: boolean) {
    const selected = draft[turn];
    const next = checked ? [...selected, step] : selected.filter(value => value !== step);
    setDraft({ ...draft, [turn]: next });
  }
  async function apply() {
    if (saving || locked) return;
    setSaving(true);
    try { if (await onSave(draft)) onClose(); } finally { setSaving(false); }
  }
  return <TableDialog title="Priority stops" className="pt-priority-dialog" reportable={false}
      onClose={saving ? undefined : onClose}>
      <p>Check a step to add a manual stop each turn. Unchecked steps use automatic priority.</p>
      <div className="pt-priority-windows"><table>
        <thead><tr><th scope="col">Priority window</th><th scope="col">Your turn</th><th scope="col">{opponentName}’s turn</th></tr></thead>
        <tbody>{windows.map(step => <tr key={step}>
          <th scope="row">{prioritySteps[step]}</th>
          {turns.map(turn => <td key={turn}><label><input type="checkbox"
              aria-label={`${prioritySteps[step]}, ${turn === "own" ? "your turn" : opponentName + "’s turn"}`}
              checked={draft[turn].includes(step)} disabled={saving}
              onChange={event => toggle(turn, step, event.currentTarget.checked)} /></label></td>)}
        </tr>)}</tbody>
      </table></div>
      {error}
      <div className="pt-priority-actions">
        <Button variant="ghost" disabled={saving || selectedCount === windows.length * turns.length}
          onClick={() => setDraft({own: [...windows], opponent: [...windows]})}>Select all</Button>
        <Button variant="ghost" disabled={saving || !selectedCount}
          onClick={() => setDraft({own: [], opponent: []})}>Clear all</Button>
        <Button disabled={saving || locked} onClick={() => void apply()}>{saving ? "Saving…" : "Apply stops"}</Button>
      </div>
    </TableDialog>;
}
