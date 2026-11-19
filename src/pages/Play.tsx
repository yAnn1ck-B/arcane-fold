import { useEffect, useRef, useState } from "react";
import { ArrowRight, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { appLifecycle } from "@/lib/app-lifecycle";
import type { AppSettings, DeckSummary } from "@/lib/types";
import { listDecks } from "@/services/decks";
import { playAction, undoAction, type Session } from "@/game/session";
import { loadSession, removeSession, saveSession } from "@/game/storage";
import { TableDialog } from "@/game/TableDialog";
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
  const [gameOpen, setGameOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
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

  async function commit(change: (() => Session) | "remove") {
    if (busy.current || !session || !loaded || !canPlay() || appLifecycle.isLocked())
      return;
    busy.current = true;
    setWorking(true);
    setError("");
    try {
      const result = change === "remove" ? null : change();
      if (result) await saveSession(result.saved, session.saved.revision);
      else await removeSession(session.saved.revision);
      if (mounted.current) {
        setSession(result);
        setConfirmRemove(false);
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
      {error && !gameOpen && !confirmRemove && (
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
            reportContext={{ id: session.saved.id, revision: session.saved.revision, error: error || undefined }}
            matchTools={{
              history: session.history,
              undoDisabled: working || !session.saved.actions.length,
              onUndo: () => void commit(() => undoAction(session)),
              leaveLabel: "Leave manual game",
              onLeave: () => setPlaying(false),
              leaveDisabled: working,
              openingRecovery: error && (
                <div className="notice notice-error" role="alert">
                  {error}
                  <Button variant="outline" onClick={() => {
                    setPlaying(false);
                    setReload((count) => count + 1);
                  }}>
                    Return to Play
                  </Button>
                </div>
              ),
            }}
            requiredOpening={session.saved.requiredOpening === true}
            initialViewer={entrySeat}
            settings={settings}
            dispatch={(action) =>
              void commit(() => playAction(session, action))
            }
          />
        </fieldset>
      ) : (
        loaded && session && (
          <section className="pt-resume panel" aria-label="Saved game">
            <div>
              <small>Saved game · Turn {session.match.turn}</small>
              <h2>
                {session.match.players[0].deckName} <span>vs.</span>{" "}
                {session.match.players[1].deckName}
              </h2>
            </div>
            <div className="pt-launch">
              <Button
                variant="outline"
                disabled={working}
                onClick={() => {
                  setError("");
                  setConfirmRemove(true);
                }}
              >
                <Trash2 size={15} /> Remove
              </Button>
              <Button
                disabled={working}
                onClick={() => {
                  setEntrySeat(session.match.active);
                  setPlaying(true);
                }}
              >
                Resume <ArrowRight size={16} />
              </Button>
            </div>
            {confirmRemove && (
              <TableDialog
                title="Remove this saved game?"
                onClose={() => {
                  if (!busy.current) setConfirmRemove(false);
                }}
              >
                <p>
                  Remove {session.match.players[0].deckName} vs.{" "}
                  {session.match.players[1].deckName} (turn {session.match.turn})
                  and its undo history?
                </p>
                {error && <p className="notice notice-error" role="alert">{error}</p>}
                <div className="pt-launch">
                  <Button
                    variant="outline"
                    disabled={working}
                    onClick={() => setConfirmRemove(false)}
                  >
                    Cancel
                  </Button>
                  <Button
                    variant="destructive"
                    disabled={working}
                    onClick={() => void commit("remove")}
                  >
                    Remove saved game
                  </Button>
                </div>
              </TableDialog>
            )}
          </section>
        )
      )}
    </section>
  );
}
