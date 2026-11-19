import { useEffect, useState } from "react";
import { Clock3, Hand, MousePointer2, Trophy, Undo2 } from "lucide-react";
import type { ForgeSeat } from "@/game/forge-match";
import { Button } from "@/components/ui/button";
import { TableDialog } from "@/game/TableDialog";
import { errorMessage, roomRequest, type ProposalDecision, type RoomHistory, type RoomProposal, type RoomView } from "./room-api";

export const playerName = (seat: ForgeSeat) => seat === "player" ? "Player 1" : "Player 2";

export function ActionStatus({ room }: { room: RoomView }) {
  const manual = room.manualState;
  const actor = manual ? manual.actor : room.state?.actor;
  const mine = room.seat === actor;
  const finished = room.status === "finished";
  const Icon = finished ? Trophy : actor == null ? Hand : mine ? MousePointer2 : Clock3;
  const label = finished ? "Game finished" : actor == null ? "Manual play"
    : mine ? "Your action" : `Waiting for ${playerName(actor)}`;
  const prompt = finished || mine ? room.state?.prompt || manual?.view.handoffDecision?.text
    : actor == null ? "Both players can act" : undefined;
  return (
    <div role="status" aria-live="polite" aria-atomic="true"
      className={`web-action-status${mine && !finished ? " web-action-mine" : ""}`}>
      <Icon aria-hidden size={20} />
      <div><strong>{label}</strong>{prompt && <span>{prompt}</span>}</div>
    </div>
  );
}

export function RewindPicker({ path, revision, disabled, request }: {
  path: string; revision: number; disabled: boolean; request: (target: number) => void;
}) {
  const [steps, setSteps] = useState<RoomHistory>();
  const [selected, setSelected] = useState<number>();
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    void roomRequest<RoomHistory>(`${path}/history`, undefined, controller.signal).then(next => {
      if (!controller.signal.aborted) {
        setSteps(next);
        setSelected(current => next.steps.some(step => step.revision === current) ? current : undefined);
      }
    }).catch(cause => { if (!controller.signal.aborted) setError(errorMessage(cause)); });
    return () => controller.abort();
  }, [path, revision, retry]);
  const list = steps?.revision === revision ? steps.steps : undefined;
  const target = selected ?? list?.at(-1)?.revision;
  if (error) return <div role="alert" className="notice notice-error">{error}
    <Button variant="outline" onClick={() => setRetry(n => n + 1)}>Retry history</Button></div>;
  if (!list) return <p role="status" className="pt-subtle">Loading past steps…</p>;
  if (!list.length) return <p className="pt-subtle">No earlier step is available.</p>;
  return (
    <div className="web-rewind">
      <label>Return to the end of this step
        <select value={target} disabled={disabled} onChange={event => setSelected(Number(event.currentTarget.value))}>
          {[...list].reverse().map(step => <option key={step.revision} value={step.revision}>
            Step {step.revision} · {step.turn > 0 ? `Turn ${step.turn} · ` : ""}{step.label}
          </option>)}
        </select>
      </label>
      <p>Later actions will be undone if your opponent agrees.</p>
      <Button size="sm" disabled={disabled || target === undefined}
        onClick={() => { if (target !== undefined) request(target); }}><Undo2 size={15} />Request undo</Button>
    </div>
  );
}

export function ConsentDialog({ proposal, seat, busy, error, answer }: {
  proposal: RoomProposal; seat: ForgeSeat; busy: boolean;
  error?: string; answer: (decision: ProposalDecision) => void;
}) {
  const mine = proposal.requester === seat;
  const undo = proposal.kind === "undo";
  const other = playerName(seat === "player" ? "opponent" : "player");
  const title = mine ? `Waiting for ${other}` : undo ? `${other} requests an undo` : `${other} requests manual play`;
  return (
    <TableDialog title={title} className="web-consent-dialog" reportable={false}>
      {undo ? <><p>Return to the end of step {proposal.targetRevision} and undo all later actions?</p>
        <p><strong>{proposal.targetLabel}</strong></p></>
        : <p>Switch this game to manual play? Both players will resolve cards and manage the table themselves for the rest of the game. Undo history will start from this position.</p>}
      {error && <p className="notice notice-error" role="alert">{error}</p>}
      <div className="pt-launch">
        {mine ? <Button variant="outline" disabled={busy} onClick={() => answer("cancel")}>Cancel request</Button> : <>
          <Button disabled={busy} onClick={() => answer("accept")}>{undo ? "Approve undo" : "Approve manual play"}</Button>
          <Button variant="outline" disabled={busy} onClick={() => answer("decline")}>Decline</Button>
        </>}
      </div>
    </TableDialog>
  );
}
