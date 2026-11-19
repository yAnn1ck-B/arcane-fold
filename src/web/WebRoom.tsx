import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Check, Copy, Hand, Undo2, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import ForgeBoard, { ForgeImageSource } from "@/game/ForgeBoard";
import type { ForgeCard, ForgeSeat } from "@/game/forge-match";
import type { MatchTools } from "@/game/TableBoard";
import { TableDialog } from "@/game/TableDialog";
import { GameIssueReporting } from "@/game/GameIssueReporter";
import { captureForgeIssue, type GameIssueReport } from "@/game/issue-report";
import { errorMessage, playUrl, roomPath, roomRequest, RoomApiError, type Move, type ProposalDecision, type RoomView } from "./room-api";
import { ActionStatus, ConsentDialog, playerName, RewindPicker } from "./RoomRequests";
import { RemoteManualTable } from "./RemoteManualTable";
import "@/styles/game.css";

function artSource(card: ForgeCard) {
  const query = new URLSearchParams({ name: card.name, set: card.setCode ?? "", number: card.collectorNumber ?? "" });
  if (card.token) query.set("token", "1");
  return `/api/art?${query}`;
}

function Invitation({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const link = playUrl("", code).href;
  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setCopyFailed(false);
    } catch {
      setCopyFailed(true);
    }
  }
  return (
    <section className="panel web-setup" aria-labelledby="waiting-heading">
      <h2 id="waiting-heading"><Users size={21} aria-hidden /> Waiting for your opponent</h2>
      <p>Open the invitation in a separate browser profile or private window. The game starts when the second player chooses a deck and joins.</p>
      <div className="web-invite">
        <div><span>Invite code</span><code>{code}</code></div>
        <Button variant="outline" onClick={() => void copy()}>{copied ? <Check size={16} /> : <Copy size={16} />}
          {copied ? "Invite link copied" : "Copy invite link"}
        </Button>
      </div>
      {copyFailed && <label className="web-field">Copy this invite link
        <input value={link} readOnly onFocus={(e) => e.currentTarget.select()} />
      </label>}
    </section>
  );
}

export default function WebRoom({ id, onLobby, onSeatChange }: {
  id: string; onLobby: () => void; onSeatChange: (seat: ForgeSeat | null) => void;
}) {
  const [room, setRoom] = useState<RoomView>();
  const [connectionError, setConnectionError] = useState("");
  const [actionError, setActionError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [sending, setSending] = useState(false);
  const [choosingStep, setChoosingStep] = useState(false);
  const [resolution, setResolution] = useState("");
  const [rewindKey, setRewindKey] = useState("");
  const previousProposal = useRef<string | undefined>(undefined);
  const pending = useRef(false);
  const path = roomPath(id);
  const acceptView = useCallback((next: RoomView) => {
    setRoom(previous => !previous || next.revision > previous.revision ||
      (next.revision === previous.revision && next.controlVersion >= previous.controlVersion) ? next : previous);
  }, []);

  useEffect(() => {
    onSeatChange(room?.seat ?? null);
    return () => onSeatChange(null);
  }, [onSeatChange, room?.seat]);

  const proposal = room?.pendingRequest;
  const result = room?.lastResolution;
  useEffect(() => {
    if (proposal) {
      previousProposal.current = proposal.id;
      setChoosingStep(false);
      setResolution("");
    } else if (result) {
      if (result.kind === "undo" && result.decision === "accept") setRewindKey(result.requestId);
      if (previousProposal.current === result.requestId) {
        const what = result.kind === "undo" ? "undo" : "manual play";
        const verb = result.decision === "accept" ? "approved" : result.decision === "cancel" ? "canceled" : "declined";
        setResolution(`${playerName(result.responder)} ${verb} the ${what} request.`);
      }
      previousProposal.current = undefined;
    }
  }, [proposal?.id, result?.requestId, result?.decision]);

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
          terminal = cause instanceof RoomApiError && [401, 403, 404].includes(cause.status);
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

  async function post(endpoint: string, body: object) {
    if (!room || pending.current || connectionError) return;
    pending.current = true;
    setSending(true);
    setActionError("");
    try {
      const next = await roomRequest<RoomView>(`${path}/${endpoint}`, {
        revision: room.revision, controlVersion: room.controlVersion, ...body,
      });
      acceptView(next);
    } catch (cause) {
      setActionError(errorMessage(cause));
      setRefresh((value) => value + 1);
    } finally {
      pending.current = false;
      setSending(false);
    }
  }

  function act(move: Move) {
    if (!room || room.status !== "playing" || proposal) return;
    if ("actionId" in move && room.state?.actor !== room.seat) return;
    setResolution("");
    void post("actions", move);
  }

  function requestUndo(targetRevision: number) {
    void post("requests", { kind: "undo", targetRevision });
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
    <Button variant="outline" onClick={() => { setActionError(""); setRefresh((value) => value + 1); }}>Refresh table</Button>
  </div> : undefined;
  if (!room || (!state && !manual)) return (
    <div className="web-play">
      <button className="web-back" onClick={onLobby}><ArrowLeft size={16} /> Back to tables</button>
      {notice}
      {room?.status === "waiting" && room.inviteCode ? <Invitation code={room.inviteCode} /> :
        !error && <p role="status">{room?.status === "waiting" ? "Waiting for your opponent…" : "Loading table…"}</p>}
    </div>
  );
  const locked = sending || !!connectionError || !!proposal;
  const canUndo = room.undoAvailable && !locked;
  const canSwitch = room.mode === "forge" && room.status === "playing";
  const showSteps = () => { setActionError(""); setChoosingStep(true); };
  const rewindPicker = <RewindPicker path={path} revision={room.revision} disabled={!canUndo} request={requestUndo} />;
  const manualButton = canSwitch && (
    <button type="button" className="pt-tool" aria-label="Request manual play" data-hint="Request manual play"
      disabled={locked} onClick={() => void post("requests", { kind: "manual" })}><Hand size={16} aria-hidden /></button>
  );
  const matchTools: MatchTools = {
    history: (manual?.history ?? state?.history) || [], undoDisabled: !canUndo, onUndo: showSteps,
    onLeave: onLobby, leaveLabel: "Back to tables", leaveDisabled: sending,
    actionStatus: <ActionStatus room={room} />, manualSwitch: manualButton, openingRecovery: notice,
    logActions: room.undoAvailable && <div className="web-log-rewind">{rewindPicker}</div>,
    decisionTools: <div className="web-decision-tools">
      <button type="button" className="pt-btn" disabled={!canUndo} onClick={showSteps}><Undo2 size={15} />Undo to a step</button>
      {manualButton}
    </div>,
  };
  return (
    <div className="web-play pt-forge">
      {notice}
      {resolution && <p className="web-room-result" role="status">{resolution}</p>}
      {manual && <RemoteManualTable key={rewindKey} state={manual} matchTools={matchTools}
        onAction={manualAction => act({ manualAction })} locked={locked}
        reportContext={{ id, revision: room.revision, error: error || undefined }} submitReport={submitReport} />}
      {state && (
      <GameIssueReporting
        capture={() => ({
          ...captureForgeIssue(id, room.seat, state, error || undefined),
          revision: room.revision,
        })}
        submit={submitReport}
      >
        <ForgeImageSource.Provider value={artSource}>
          <ForgeBoard key={rewindKey} state={state} viewer={room.seat} locked={locked} imageCacheDir=""
            onChoose={actionId => act({ actionId })}
            onPriorityStop={stop => act({ stop })}
            replay={onLobby}
            matchTools={matchTools}
          />
        </ForgeImageSource.Provider>
      </GameIssueReporting>)}
      {choosingStep && !proposal && <TableDialog title="Undo to a step" reportable={false}
        onClose={sending ? undefined : () => setChoosingStep(false)}>
        {rewindPicker}
        {error && <p role="alert" className="notice notice-error">{error}</p>}
      </TableDialog>}
      {proposal && <ConsentDialog key={proposal.id} proposal={proposal} seat={room.seat}
        busy={sending || !!connectionError} error={error} answer={answer} />}
    </div>
  );
}
