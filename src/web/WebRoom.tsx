import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Flag, Hand, Users } from "lucide-react";
import { useToast } from "@/components/ToastProvider";
import { Button } from "@/components/ui/button";
import ForgeBoard, { ForgeImageSource } from "@/game/ForgeBoard";
import type { ForgeCard } from "@/game/forge-match";
import type { MatchTools } from "@/game/TableBoard";
import { TableDialog } from "@/game/TableDialog";
import { GameIssueReporting } from "@/game/GameIssueReporter";
import { captureForgeIssue, type GameIssueReport } from "@/game/issue-report";
import { errorMessage, roomPath, roomRequest, RoomApiError, type Move, type ProposalDecision, type RoomView } from "./room-api";
import { ActionStatus, ConsentDialog, RoomLog } from "./RoomRequests";
import { RemoteManualTable } from "./RemoteManualTable";
import { GameResult } from "./GameResult";
import "@/styles/game.css";

function artSource(card: ForgeCard) {
  const query = new URLSearchParams({ name: card.name, set: card.setCode ?? "", number: card.collectorNumber ?? "" });
  if (card.token) query.set("token", "printing");
  return `/api/art?${query}`;
}

export default function WebRoom({ id, onLobby }: {
  id: string; onLobby: () => void;
}) {
  const [room, setRoom] = useState<RoomView>();
  const [connectionError, setConnectionError] = useState("");
  const [actionError, setActionError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [sending, setSending] = useState(false);
  const [confirmConcede, setConfirmConcede] = useState(false);
  const [reviewRevision, setReviewRevision] = useState<number | null>(null);
  const toast = useToast();
  const [rewindKey, setRewindKey] = useState("");
  const previousProposal = useRef<string | undefined>(undefined);
  const pending = useRef(false);
  const path = roomPath(id);
  const acceptView = useCallback((next: RoomView) => {
    setRoom(previous => !previous || next.revision > previous.revision ||
      (next.revision === previous.revision && next.controlVersion >= previous.controlVersion) ? next : previous);
  }, []);

  const proposal = room?.pendingRequest;
  const finished = room?.status === "finished";
  useEffect(() => { if (finished) setConfirmConcede(false); }, [finished]);
  const result = room?.lastResolution;
  const responderName = result && room?.seatNames[result.responder];
  useEffect(() => {
    if (proposal) {
      previousProposal.current = proposal.id;
    } else if (result) {
      if (result.kind === "undo" && result.decision === "accept") setRewindKey(result.requestId);
      if (previousProposal.current === result.requestId && responderName) {
        const what = result.kind === "undo" ? "undo" : "manual play";
        const verb = result.decision === "accept" ? "approved" : result.decision === "cancel" ? "canceled" : "declined";
        toast(`${responderName} ${verb} the ${what} request.`);
      }
      previousProposal.current = undefined;
    }
  }, [proposal?.id, result?.requestId, result?.decision, responderName, toast]);

  useEffect(() => {
    const controller = new AbortController();
    let timer: number | undefined;
    let reading = false;
    let terminal = false;
    async function poll() {
      if (reading || terminal || controller.signal.aborted) return;
      window.clearTimeout(timer);
      reading = true;
      try {
        const view = await roomRequest<RoomView>(path, undefined, controller.signal);
        if (!controller.signal.aborted) {
          acceptView(view);
          setConnectionError("");
        }
      } catch (cause) {
        if (!controller.signal.aborted) {
          setConnectionError(errorMessage(cause));
          terminal = cause instanceof RoomApiError && [401, 403, 404, 409, 410].includes(cause.status);
          if (terminal) setRoom(undefined);
        }
      } finally {
        reading = false;
        if (!terminal && !controller.signal.aborted) {
          timer = window.setTimeout(poll, document.hidden ? 3000 : 850);
        }
      }
    }
    const wake = () => { if (!document.hidden) void poll(); };
    void poll();
    window.addEventListener("online", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
      window.removeEventListener("online", wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [path, refresh, acceptView]);

  async function roomAction<T>(endpoint: string, body: object, onSuccess: (next: T) => void) {
    if (!room || pending.current || connectionError) return false;
    pending.current = true;
    setSending(true);
    setActionError("");
    try {
      const next = await roomRequest<T>(`${path}/${endpoint}`, {
        revision: room.revision, controlVersion: room.controlVersion, ...body,
      });
      onSuccess(next);
      return true;
    } catch (cause) {
      setActionError(errorMessage(cause));
      setRefresh((value) => value + 1);
      return false;
    } finally {
      pending.current = false;
      setSending(false);
    }
  }

  function post(endpoint: string, body: object) {
    return roomAction<RoomView>(endpoint, body, acceptView);
  }

  function act(move: Move) {
    if (!room || room.status !== "playing" || proposal) return;
    if ("actionId" in move && room.state?.actor !== room.seat) return;
    void post("actions", move);
  }

  function requestUndo(targetRevision: number) {
    if (room?.status === "playing" && room.undoAvailable && !proposal) void post("requests", { kind: "undo", targetRevision });
  }

  function answer(decision: ProposalDecision) {
    if (proposal) void post("requests", { requestId: proposal.id, decision });
  }

  async function submitReport(report: GameIssueReport) {
    const { id, appVersion, capturedAt, visibleDialog, visibleControls, visibleControlsTruncated, error } = report;
    await roomRequest(`${path}/reports`, {
      revision: report.revision, details: report.expectedBehavior,
      report: { id, appVersion, capturedAt, visibleDialog, visibleControls, visibleControlsTruncated, error },
    });
  }

  const state = room?.state;
  const manual = room?.manualState;
  const error = connectionError || actionError;
  const notice = error ? <div role="alert" className="notice notice-error">{error}
    <Button variant="outline" onClick={() => { setActionError(""); setRefresh((value) => value + 1); }}>Refresh game</Button>
  </div> : undefined;
  if (!room || (!state && !manual)) return (
    <div className="web-play">
      <button className="web-back" onClick={onLobby}><ArrowLeft size={16} /> Return to lobby</button>
      {notice}
      {room?.status === "waiting" ? <section className="panel web-setup" aria-labelledby="waiting-heading">
        <h2 id="waiting-heading"><Users size={21} aria-hidden /> Waiting for opponent</h2>
        <Button variant="outline" disabled={sending || !!connectionError}
          onClick={() => void roomAction<{ id: string }>("cancel", {}, onLobby)}>
          Close open game
        </Button>
      </section> : !error && <p role="status">Loading game…</p>}
    </div>
  );
  const locked = sending || !!connectionError || !!proposal;
  const canSwitch = room.mode === "forge" && room.status === "playing";
  const showingResult = finished && reviewRevision !== room.revision;
  const opponentName = room.seatNames[room.seat === "player" ? "opponent" : "player"];
  const entries = manual?.history ?? state?.history ?? [];
  const manualButton = canSwitch && (
    <button type="button" className="pt-tool"
      disabled={locked} onClick={() => void post("requests", { kind: "manual" })}><Hand size={16} aria-hidden />Manual play</button>
  );
  const concedeButton = !finished && (
    <button type="button" className="pt-btn" disabled={sending || !!connectionError} aria-haspopup="dialog"
      onClick={() => { setActionError(""); setConfirmConcede(true); }}><Flag size={15} aria-hidden />Concede</button>
  );
  const matchTools: MatchTools = {
    seatNames: room.seatNames,
    history: entries,
    historyLog: <RoomLog path={path} revision={room.revision} entries={entries}
      available={room.status === "playing" && room.undoAvailable} disabled={locked} request={requestUndo} />,
    onLeave: onLobby, leaveLabel: "Return to lobby", leaveDisabled: sending,
    actionStatus: <ActionStatus room={room} />, manualSwitch: manualButton, concede: concedeButton, decisionError: notice,
  };
  return (
    <div className="web-play pt-forge">
      {notice}
      {showingResult && <GameResult room={room} onLobby={onLobby} onReview={() => setReviewRevision(room.revision)} />}
      {finished && !showingResult && <button className="web-back" onClick={() => setReviewRevision(null)}>
        <ArrowLeft size={16} aria-hidden /> Back to result</button>}
      {!showingResult && manual && <RemoteManualTable key={rewindKey} state={manual} matchTools={matchTools}
        onAction={manualAction => act({ manualAction })} locked={locked || finished}
        reportContext={{ id, revision: room.revision, error: error || undefined }} submitReport={submitReport} />}
      {!showingResult && state && (
      <GameIssueReporting
        capture={() => ({
          ...captureForgeIssue(id, room.seat, state, error || undefined),
          revision: room.revision,
        })}
        submit={submitReport}
      >
        <ForgeImageSource.Provider value={artSource}>
          <ForgeBoard key={rewindKey} state={state} viewer={room.seat} locked={locked || finished}
            onChoose={actionId => act({ actionId })}
            onPriorityStop={stop => post("actions", { stop })}
            matchTools={matchTools}
          />
        </ForgeImageSource.Provider>
      </GameIssueReporting>)}
      {proposal && !confirmConcede && <ConsentDialog key={proposal.id} proposal={proposal} seat={room.seat} requesterName={room.seatNames[proposal.requester]} opponentName={opponentName}
        busy={sending || !!connectionError} error={error} answer={answer} />}
      {confirmConcede && !finished && <TableDialog title="Concede this game?" reportable={false}
        className="web-consent-dialog" onClose={sending ? undefined : () => setConfirmConcede(false)}>
        <p>{opponentName} will win immediately.</p>
        {error && <p className="notice notice-error" role="alert">{error}</p>}
        <div className="pt-launch">
          <Button variant="outline" disabled={sending} onClick={() => setConfirmConcede(false)}>Keep playing</Button>
          <Button variant="destructive" disabled={sending || !!connectionError}
            onClick={() => void post("actions", { concede: true })}><Flag size={15} aria-hidden />Concede game</Button>
        </div>
      </TableDialog>}
    </div>
  );
}
