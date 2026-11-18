import { useEffect, useRef, useState } from "react";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { appLifecycle } from "@/lib/app-lifecycle";
import type { AppSettings, DeckSummary } from "@/lib/types";
import { listDecks } from "@/services/decks";
import { playAction, undoAction, type Session } from "@/game/session";
import { loadSession, saveSession } from "@/game/storage";
import Table from "@/game/Table";
import Game from "@/game/Game";
import type { Seat } from "@/game/types";
import "@/styles/game.css";

export default function PlayPage({
  settings,
  canPlay,
  onDeckBuilder,
}: {
  settings: AppSettings;
  canPlay: () => boolean;
  onDeckBuilder: () => void;
}) {
  const [decks, setDecks] = useState<DeckSummary[]>([]);
  const [session, setSession] = useState<Session | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [deckListReady, setDeckListReady] = useState(false);
  const [reload, setReload] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [entrySeat, setEntrySeat] = useState<Seat>();
  const [concealOnEntry, setConcealOnEntry] = useState(false);
  const [gameOpen, setGameOpen] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const busy = useRef(false);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    let active = true;
    setError("");
    setLoaded(false);
    setDeckListReady(false);
    void loadSession()
      .then((saved) => {
        if (active) {
          setSession(saved);
          setLoaded(true);
        }
      })
      .catch((reason) => {
        if (active) setError(String(reason));
      });
    void listDecks()
      .then((list) => {
        if (!active) return;
        const playable = list.filter((deck) => deck.mainCount > 0);
        setDecks(playable);
        setDeckListReady(true);
      })
      .catch((reason) => {
        if (active) setError(String(reason));
      });
    return () => {
      active = false;
      mounted.current = false;
    };
  }, [reload]);

  async function commit(next: () => Session | Promise<Session>) {
    if (busy.current || !loaded || !canPlay() || appLifecycle.isLocked())
      return;
    busy.current = true;
    setWorking(true);
    setError("");
    try {
      const result = await next();
      if (!mounted.current || !canPlay() || appLifecycle.isLocked()) return;
      await saveSession(result.saved, session?.saved.revision);
      if (mounted.current) {
        setSession(result);
      }
    } catch (reason) {
      if (mounted.current)
        setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      busy.current = false;
      if (mounted.current) setWorking(false);
    }
  }

  return (
    <section className="game-page">
      {!playing && (
        <Game
          open={gameOpen}
          onOpenChange={setGameOpen}
          canPlay={canPlay}
          disabled={working}
          imageCacheDir={settings.forge.imageCacheDir}
          decks={decks}
          decksReady={deckListReady}
          onDeckBuilder={onDeckBuilder}
          onManualSaved={(manual, viewer) => {
            setSession(manual);
            setLoaded(true);
            setEntrySeat(viewer);
            setConcealOnEntry(true);
            setError("");
            setGameOpen(false);
            setPlaying(true);
          }}
          suggestedDeckId={
            decks.find(
              (deck) => deck.name === session?.match.players[0].deckName,
            )?.id
          }
        />
      )}
      {error && !gameOpen && (
        <div className="notice notice-error" role="alert">
          {error}
          {(!loaded || !deckListReady) && (
            <Button variant="outline" onClick={() => setReload((n) => n + 1)}>
              Retry
            </Button>
          )}
        </div>
      )}
      {gameOpen ? null : playing && session ? (
        <fieldset disabled={working} className="pt-table-inputs">
          <Table
            key={session.saved.id}
            match={session.match}
            matchTools={{
              history: session.history,
              undoDisabled: working || !session.saved.actions.length,
              onUndo: () => void commit(() => undoAction(session)),
              leaveLabel: "Leave manual game",
              onLeave: () => setPlaying(false),
              leaveDisabled: working,
            }}
            requiredOpening={session.saved.requiredOpening === true}
            openingError={error}
            initialViewer={entrySeat}
            initialHandoff={concealOnEntry}
            settings={settings}
            dispatch={(action) =>
              void commit(() => playAction(session, action))
            }
          />
        </fieldset>
      ) : (
        <>
          {loaded && session && (
            <div className="pt-resume panel">
              <div>
                <small>Saved game · Turn {session.match.turn}</small>
                <h2>
                  {session.match.players[0].deckName} <span>vs.</span>{" "}
                  {session.match.players[1].deckName}
                </h2>
              </div>
              <Button
                disabled={working}
                onClick={() => {
                  setEntrySeat(session.match.active);
                  setConcealOnEntry(true);
                  setPlaying(true);
                }}
              >
                Resume <ArrowRight size={16} />
              </Button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
