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
  const openRooms = session?.openRooms ?? [];
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

  async function roomAction(path: string, body: object, onSuccess = onRoom) {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await roomRequest<{ id: string }>(path, body);
      onSuccess(result.id);
    } catch (cause) {
      setError(errorMessage(cause));
      setRefresh(value => value + 1);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  function closeOpenGame(id: string) {
    void roomAction(`${roomPath(id)}/cancel`, {}, (closedId) => {
      setSession(previous => previous && {...previous, rooms:previous.rooms.filter(room => room.id !== closedId)});
      setRefresh(value => value + 1);
    });
  }

  return (
    <div className="web-play">
      {loadError && <div role="alert" className="notice notice-error">{loadError}
        <Button variant="outline" onClick={() => setRefresh(value => value + 1)}>Retry</Button>
      </div>}
      {!session && !loadError && <p role="status">Loading games…</p>}
      {session && <>
        <section className="panel web-setup" aria-labelledby="table-heading">
          <h2 id="table-heading"><Swords aria-hidden size={21} /> {current ? "Current game" : "Play with a friend"}</h2>
          {current ? <>
            <div><strong>{current.label}</strong>
              <p>{current.status === "waiting" ? "Waiting for opponent"
                : `${current.seatNames.player} vs. ${current.seatNames.opponent}`}</p>
            </div>
            <div className="web-room-actions">
              <Button disabled={busy} onClick={() => onRoom(current.id)}>
                {current.status === "waiting" ? "Return to open game" : "Continue game"} <ArrowRight size={16} aria-hidden />
              </Button>
              {current.status === "waiting" && <Button variant="outline" disabled={busy}
                onClick={() => closeOpenGame(current.id)}>Close open game</Button>}
            </div>
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
            <Button disabled={busy || !deck} onClick={() => void roomAction("/rooms",{deckId:deck?.id})}>
              <Plus size={16} aria-hidden /> Create game
            </Button>
          </div>}
        </section>
        {error && <p role="alert" className="notice notice-error">{error}</p>}
        {!current && openRooms.length > 0 && (
          <section className="panel web-rooms web-open-rooms" aria-labelledby="open-games-heading">
            <h2 id="open-games-heading">Open games</h2>
            <ul>
              {openRooms.map(room => (
                <li key={room.id}>
                  <div><strong>{room.hostName}’s game</strong>
                    <span>{new Date(room.openedAt).toLocaleString(undefined,{dateStyle:"short",timeStyle:"short"})}</span>
                  </div>
                  <Button variant="outline" disabled={busy || !deck} aria-label={`Join game hosted by ${room.hostName}`}
                    onClick={() => void roomAction("/join",{roomId:room.id,deckId:deck?.id})}>
                    Join game <ArrowRight size={15} aria-hidden />
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        )}
        {[{title:"Earlier unfinished games", rooms:earlier}, {title:"Finished games", rooms:finished}].map(group =>
          group.rooms.length > 0 && <details key={group.title} className="panel web-rooms">
            <summary>{group.title} ({group.rooms.length})</summary>
            {group.rooms.some(room => room.paused) && current &&
              <p>{current.status === "waiting" ? "Close your open game to resume a saved game." : "Finish your current game to resume a saved game."}</p>}
            <ul>{group.rooms.map(room => <li key={room.id}>
              <div><strong>{room.label || "Game"}</strong>
                <span>{room.seatNames.player} vs. {room.seatNames.opponent} · {new Date(room.updatedAt).toLocaleString(undefined,{dateStyle:"short",timeStyle:"short"})}</span>
              </div>
              <Button variant="outline" disabled={busy || (room.paused && !!current)}
                onClick={() => room.paused ? void roomAction(`${roomPath(room.id)}/resume`,{}) : onRoom(room.id)}>
                {room.status === "finished" ? "View result" : "Resume game"} <ArrowRight size={15} />
              </Button>
            </li>)}</ul>
          </details>)}
      </>}
    </div>
  );
}
