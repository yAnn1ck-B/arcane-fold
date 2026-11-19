import { useEffect, useState } from "react";
import { Clock3, Hand, MousePointer2, Trophy } from "lucide-react";
import { GameHistory } from "@/game/GameHistory";
import { turnPhases, type HistoryEntry } from "@/game/types";
import type { ForgeSeat } from "@/game/forge-match";
import { Button } from "@/components/ui/button";
import { TableDialog } from "@/game/TableDialog";
import { errorMessage, roomRequest, type ProposalDecision, type RoomHistory, type RoomProposal, type RoomView } from "./room-api";

export function ActionStatus({ room }: { room: RoomView }) {
  const manual = room.manualState;
  const actor = manual ? manual.actor : room.state?.actor;
  const mine = room.seat === actor;
  const finished = room.status === "finished";
  const Icon = finished ? Trophy : actor == null ? Hand : mine ? MousePointer2 : Clock3;
  const other = room.seat === "player" ? "opponent" : "player";
  const label = finished ? "Game finished" : actor == null ? "Manual play"
    : mine ? "Your action" : `Waiting for ${room.seatNames[other]}…`;
  const prompt = finished || mine ? room.state?.prompt || manual?.view.handoffDecision?.text
    : actor == null ? "Both players can act" : undefined;
  const manualPhase = manual && turnPhases.find(phase => phase.steps.includes(manual.phase));
  const phase = manual ? manual.requiredOpening ? ["Opening hand"] : [manualPhase?.name, manual.phase]
    : [room.state?.phase, room.state?.step];
  const position = [...new Set(phase.filter(Boolean))].join(" · ");
  return (
    <div role="status" aria-live="polite" aria-atomic="true"
      className={`web-action-status${mine && !finished ? " web-action-mine" : ""}`}>
      <Icon aria-hidden size={20} />
      <div><strong>{label}</strong>{prompt && <span>{prompt}</span>}</div>
      {position && <span className="web-action-phase">{position}</span>}
    </div>
  );
}

export function RoomLog({ path, revision, entries, available, disabled, request }: {
  path: string; revision: number; entries: HistoryEntry[]; available: boolean;
  disabled: boolean; request: (target: number) => void;
}) {
  const [history, setHistory] = useState<RoomHistory>();
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!available) return;
    const controller = new AbortController();
    setError("");
    void roomRequest<RoomHistory>(`${path}/history`, undefined, controller.signal).then(next => {
      if (!controller.signal.aborted) setHistory(next);
    }).catch(cause => { if (!controller.signal.aborted) setError(errorMessage(cause)); });
    return () => controller.abort();
  }, [available, path, revision, retry]);
  const steps = available && history?.revision === revision ? history.steps : undefined;
  return <>
    {available && error && <div role="alert" className="notice notice-error">{error}
      <Button variant="outline" onClick={() => setRetry(n => n + 1)}>Retry history</Button></div>}
    <GameHistory entries={entries} steps={steps} disabled={disabled} onUndo={request} />
  </>;
}

export function ConsentDialog({ proposal, seat, requesterName, opponentName, busy, error, answer }: {
  proposal: RoomProposal; seat: ForgeSeat; requesterName: string; opponentName: string; busy: boolean;
  error?: string; answer: (decision: ProposalDecision) => void;
}) {
  const mine = proposal.requester === seat;
  const undo = proposal.kind === "undo";
  const title = mine ? `Waiting for ${opponentName}…` : undo ? `${requesterName} requests an undo` : `${requesterName} requests manual play`;
  return (
    <TableDialog title={title} className="web-consent-dialog" reportable={false}>
      {undo ? <><p>Return to the end of step {proposal.targetRevision} and undo all later actions?</p>
        <p><strong>{proposal.targetLabel}</strong></p></>
        : <p>Switch this game to manual play? Both players will resolve cards and manage the board themselves for the rest of the game. Undo history will start from this position.</p>}
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
