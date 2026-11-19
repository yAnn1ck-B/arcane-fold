import { useEffect, useRef, useState } from "react";
import { ArrowRight, Plus, Swords } from "lucide-react";
import { Button } from "@/components/ui/button";
import { errorMessage, playUrl, roomPath, roomRequest, type WebSession } from "./room-api";
import WebRoom from "./WebRoom";
import "./web-play.css";

const currentRoom = () => new URL(window.location.href).searchParams.get("room") ?? "";

export default function WebPlay({ leagueRevision }: { leagueRevision: number }) {
  const [room, setRoom] = useState(currentRoom);

  useEffect(() => {
    const navigateBack = () => setRoom(currentRoom());
    window.addEventListener("popstate", navigateBack);
    return () => window.removeEventListener("popstate", navigateBack);
  }, []);

  function navigate(next = "") {
    window.history.pushState(window.history.state, "", playUrl(next));
    setRoom(next);
  }

  if (room) return <WebRoom key={room} id={room} onLobby={() => navigate()} />;
  return <>
    <header className="page-heading"><h1>Play</h1></header>
    <Lobby onRoom={navigate} leagueRevision={leagueRevision} />
  </>;
}

function Lobby({ onRoom, leagueRevision }: { onRoom: (id: string) => void; leagueRevision: number }) {
  const [session, setSession] = useState<WebSession>();
  const [refresh, setRefresh] = useState(0);
  const [loadError, setLoadError] = useState("");
  const [selection, setSelection] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submitting = useRef(false);
  const decks = session?.decks ?? [];
  const deck = decks.find(item => item.id === selection && !item.unavailableReason) ?? decks.find(item => !item.unavailableReason);
  const saved = decks.filter(item => !item.practice);
  const current = session?.rooms.find(room => room.current);
  const open = session?.openRooms[0];
  const earlier = session?.rooms.filter(room => !room.current && room.status === "playing") ?? [];
  const finished = session?.rooms.filter(room => room.status === "finished") ?? [];

  useEffect(() => {
    const controller = new AbortController();
    let reading = false;
    async function refreshLobby() {
      if (reading || document.hidden) return;
      reading = true;
      try {
        const next = await roomRequest<WebSession>("/session", undefined, controller.signal);
        if (!controller.signal.aborted) { setSession(next); setLoadError(""); }
      } catch (cause) {
        if (!controller.signal.aborted) setLoadError(errorMessage(cause));
      } finally {
        reading = false;
      }
    }
    void refreshLobby();
    const timer = window.setInterval(refreshLobby, 3000);
    document.addEventListener("visibilitychange", refreshLobby);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshLobby);
    };
  }, [leagueRevision, refresh]);

  async function enterGame(path: string, body: object) {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await roomRequest<{ id: string }>(path, body);
      onRoom(result.id);
    } catch (cause) {
      setError(errorMessage(cause));
      setRefresh(value => value + 1);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="web-play">
      {loadError && <div role="alert" className="notice notice-error">{loadError}
        <Button variant="outline" onClick={() => setRefresh(value => value + 1)}>Retry</Button>
      </div>}
      {!session && !loadError && <p role="status">Loading games…</p>}
      {session && <>
        <section className="panel web-setup" aria-labelledby="table-heading">
          <h2 id="table-heading"><Swords aria-hidden size={21} /> {current ? "Current game" : open ? `${open.hostName}’s open game` : "Play with a friend"}</h2>
          {current ? <>
            <div><strong>{current.label}</strong>
              <p>{current.status === "waiting" ? `Waiting for ${current.waitingForName ?? "opponent"}…`
                : `${current.seatNames.player} vs. ${current.seatNames.opponent}`}</p>
            </div>
            <Button onClick={() => onRoom(current.id)}>{current.status === "waiting" ? "Return to open game" : "Continue game"} <ArrowRight size={16} /></Button>
          </> : <div className="web-table-setup">
            <label className="web-field">Choose your deck
              <select value={deck?.id ?? ""} disabled={busy} onChange={event => setSelection(event.target.value)}>
                <optgroup label="Your saved decks">
                  {saved.length ? saved.map(item =>
                    <option key={item.id} value={item.id} disabled={!!item.unavailableReason}>
                      {item.name}{item.unavailableReason ? ` — ${item.unavailableReason}` : ""}
                    </option>
                  ) : <option disabled value="">No saved decks yet</option>}
                </optgroup>
                <optgroup label="Read-only practice decks">
                  {decks.map(({ id, practice }) => practice &&
                    <option key={id} value={id}>{practice.name} · {practice.color} · {practice.mainCount} cards</option>)}
                </optgroup>
              </select>
            </label>
            {open ? <Button disabled={busy || !deck} onClick={() => void enterGame("/join",{roomId:open.id,deckId:deck?.id})}>Join game <ArrowRight size={16} /></Button>
              : <Button disabled={busy || !deck} onClick={() => void enterGame("/rooms",{deckId:deck?.id})}><Plus size={16} /> Create game</Button>}
          </div>}
        </section>
        {error && <p role="alert" className="notice notice-error">{error}</p>}
        {[{title:"Earlier unfinished games", rooms:earlier}, {title:"Finished games", rooms:finished}].map(group =>
          group.rooms.length > 0 && <details key={group.title} className="panel web-rooms">
            <summary>{group.title} ({group.rooms.length})</summary>
            {group.rooms.some(room => room.paused) && (current || open) &&
              <p>Finish the current game to resume a saved game.</p>}
            <ul>{group.rooms.map(room => <li key={room.id}>
              <div><strong>{room.label || "Game"}</strong>
                <span>{room.seatNames.player} vs. {room.seatNames.opponent} · {new Date(room.updatedAt).toLocaleString(undefined,{dateStyle:"short",timeStyle:"short"})}</span>
              </div>
              <Button variant="outline" disabled={busy || (room.paused && !!(current || open))}
                onClick={() => room.paused ? void enterGame(`${roomPath(room.id)}/resume`,{}) : onRoom(room.id)}>
                {room.status === "finished" ? "View result" : "Resume game"} <ArrowRight size={15} />
              </Button>
            </li>)}</ul>
          </details>)}
      </>}
    </div>
  );
}
