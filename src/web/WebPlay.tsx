import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowRight, DoorOpen, Plus, Swords } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ForgeSeat } from "@/game/forge-match";
import { errorMessage, playUrl, readSession, roomRequest, type WebSession } from "./room-api";
import WebRoom from "./WebRoom";
import "./web-play.css";

function readRoute() {
  const params = new URL(window.location.href).searchParams;
  return { room: params.get("room") || "", join: params.get("join") || "" };
}

export default function WebPlay({ onSeatChange }: { onSeatChange: (seat: ForgeSeat | null) => void }) {
  const [route, setRoute] = useState(readRoute);
  const [session, setSession] = useState<WebSession>();
  const [refresh, setRefresh] = useState(0);
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    const navigateBack = () => setRoute(readRoute());
    window.addEventListener("popstate", navigateBack);
    return () => window.removeEventListener("popstate", navigateBack);
  }, []);

  useEffect(() => {
    let active = true;
    setLoadError("");
    readSession()
      .then((value) => { if (active) setSession(value); })
      .catch((cause) => { if (active) setLoadError(errorMessage(cause)); });
    return () => { active = false; };
  }, [route.room, refresh]);

  function navigate(room = "") {
    window.history.pushState(window.history.state, "", playUrl(room));
    setRoute(readRoute());
  }

  if (route.room && session) return <WebRoom key={route.room} id={route.room} onLobby={() => navigate()} onSeatChange={onSeatChange} />;
  return (
    <div className="web-play">
      {loadError && <div role="alert" className="notice notice-error">{loadError}
        <Button variant="outline" onClick={() => setRefresh((value) => value + 1)}>Retry</Button>
      </div>}
      {!session && !loadError && <p role="status">Loading tables…</p>}
      {session && <Lobby key={route.join} session={session} invite={route.join} onRoom={navigate} />}
    </div>
  );
}

function Lobby({ session, invite, onRoom }: { session: WebSession; invite: string; onRoom: (id: string) => void }) {
  const [selection, setSelection] = useState("");
  const [code, setCode] = useState(invite);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submitting = useRef(false);
  const deck = session.decks.find((item) => item.id === selection) ?? session.decks[0];

  async function openTable(join: boolean) {
    if (submitting.current || !deck || (join && !code.trim())) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await roomRequest<{ id: string }>(
        join ? "/join" : "/rooms", join ? { code: code.trim(), deckId: deck.id } : { deckId: deck.id },
      );
      onRoom(result.id);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  function join(event: FormEvent) {
    event.preventDefault();
    void openTable(true);
  }

  return (
    <>
      <section className="panel web-setup" aria-labelledby="table-heading">
        <h2 id="table-heading"><Swords aria-hidden size={21} /> Play with a friend</h2>
        <p>Each player chooses a deck and plays from their own browser session.</p>
        <label className="web-field">Your deck
          <select value={deck?.id ?? ""} disabled={busy || !deck} onChange={(e) => setSelection(e.target.value)}>
            {!deck && <option value="">No playable decks</option>}
            {session.decks.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}
          </select>
        </label>
        {error && <p role="alert" className="notice notice-error">{error}</p>}
        <div className="web-ways">
          <Button disabled={busy || !deck} onClick={() => void openTable(false)}><Plus size={16} /> Create table</Button>
          <form onSubmit={join} className="web-join">
            <label className="web-field">Invite code
              <input value={code} onChange={(event) => setCode(event.target.value)} disabled={busy} maxLength={128}
                autoComplete="off" autoCapitalize="none" spellCheck={false} />
            </label>
            <Button variant={invite ? "default" : "outline"} disabled={busy || !deck || !code.trim()} type="submit">
              Join table <ArrowRight size={16} />
            </Button>
          </form>
        </div>
      </section>
      {session.rooms.length > 0 && <section className="panel web-rooms" aria-labelledby="rooms-heading">
        <h2 id="rooms-heading"><DoorOpen size={20} aria-hidden /> Your tables</h2>
        <ul>{session.rooms.map((room) => <li key={room.id}>
          <div><strong>{room.label || "Game table"}</strong>
            <span>{room.status === "waiting" ? "Waiting for opponent" : room.status === "playing" ? "In play" : "Finished"}
              {" · "}Player {room.seat === "player" ? 1 : 2}</span>
          </div>
          <Button variant="outline" disabled={busy} onClick={() => onRoom(room.id)}>
            {room.status === "finished" ? "View game" : "Open table"} <ArrowRight size={15} />
          </Button>
        </li>)}</ul>
      </section>}
    </>
  );
}
