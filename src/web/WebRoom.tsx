import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Check, Copy, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import ForgeBoard, { ForgeImageSource } from "@/game/ForgeBoard";
import type { ForgeCard } from "@/game/forge-match";
import { GameIssueReporting } from "@/game/GameIssueReporter";
import { captureForgeIssue } from "@/game/issue-report";
import { errorMessage, playUrl, roomPath, roomRequest, RoomApiError, type Move, type RoomView } from "./room-api";
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

export default function WebRoom({ id, onLobby }: { id: string; onLobby: () => void }) {
  const [room, setRoom] = useState<RoomView>();
  const [connectionError, setConnectionError] = useState("");
  const [actionError, setActionError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [sending, setSending] = useState(false);
  const pending = useRef(false);
  const path = roomPath(id);
  const acceptView = useCallback((next: RoomView) => {
    setRoom((previous) => !previous || next.revision >= previous.revision ? next : previous);
  }, []);

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
          terminal = view.status === "finished";
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

  async function act(move: Move) {
    if (!room?.state || room.status !== "playing" || pending.current || connectionError) return;
    if ("actionId" in move && room.state.actor !== room.seat) return;
    pending.current = true;
    setSending(true);
    setActionError("");
    try {
      const next = await roomRequest<RoomView>(`${path}/actions`, { revision: room.revision, ...move });
      acceptView(next);
    } catch (cause) {
      setActionError(errorMessage(cause));
      setRefresh((value) => value + 1);
    } finally {
      pending.current = false;
      setSending(false);
    }
  }

  const state = room?.state;
  const error = connectionError || actionError;
  const notice = error ? <div role="alert" className="notice notice-error">{error}
    <Button variant="outline" onClick={() => { setActionError(""); setRefresh((value) => value + 1); }}>Refresh table</Button>
  </div> : undefined;
  if (!room || !state) return (
    <div className="web-play">
      <button className="web-back" onClick={onLobby}><ArrowLeft size={16} /> Back to tables</button>
      {notice}
      {room?.status === "waiting" && room.inviteCode ? <Invitation code={room.inviteCode} /> :
        !error && <p role="status">{room?.status === "waiting" ? "Waiting for your opponent…" : "Loading table…"}</p>}
    </div>
  );
  return (
    <div className="web-play pt-forge">
      {notice}
      <GameIssueReporting
        capture={() => ({
          ...captureForgeIssue(id, room.seat, state, error || undefined),
          revision: room.revision,
        })}
        submit={async (report) => {
          const { id, appVersion, capturedAt, visibleDialog, visibleControls, visibleControlsTruncated, error } = report;
          await roomRequest(`${path}/reports`, {
            revision: report.revision,
            details: report.expectedBehavior,
            report: { id, appVersion, capturedAt, visibleDialog, visibleControls, visibleControlsTruncated, error },
          });
        }}
      >
        <ForgeImageSource.Provider value={artSource}>
          <ForgeBoard state={state} viewer={room.seat} locked={sending || !!connectionError} imageCacheDir=""
            onChoose={(actionId) => void act({ actionId })}
            onPriorityStop={(stop) => void act({ stop })}
            replay={onLobby}
            matchTools={{
              history: state.history, undoDisabled: true, onLeave: onLobby,
              leaveLabel: "Back to tables", leaveDisabled: sending,
              contextLabel: `Player ${room.seat === "player" ? 1 : 2}`,
              openingRecovery: notice,
            }}
          />
        </ForgeImageSource.Provider>
      </GameIssueReporting>
    </div>
  );
}
