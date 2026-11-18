import { useEffect, useRef, useState } from "react";
import { ArrowRight, Play, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { appLifecycle } from "@/lib/app-lifecycle";
import type { AppSettings, DeckDetail, DeckSummary } from "@/lib/types";
import { listDecks, loadDeck } from "@/services/decks";
import { createMatch } from "@/playtest/engine";
import {
  newSession,
  playAction,
  undoAction,
  type Session,
} from "@/playtest/session";
import { loadSession, saveSession } from "@/playtest/storage";
import Table from "@/playtest/Table";
import ForgePractice from "@/playtest/ForgePractice";
import { GameHistory } from "@/playtest/GameHistory";
import type { Seat } from "@/playtest/types";
import "@/styles/playtest.css";

const practiceSeat: DeckDetail = {
  id: "",
  name: "Practice seat",
  cards: [],
  createdAt: "",
  updatedAt: "",
};

export default function Playtest({
  settings,
  canPlay,
  onDeckBuilder,
}: {
  settings: AppSettings;
  canPlay: () => boolean;
  onDeckBuilder: () => void;
}) {
  const [decks, setDecks] = useState<DeckSummary[]>([]);
  const [selections, setSelections] = useState<[string, string]>(["", ""]);
  const [first, setFirst] = useState<Seat>(0);
  const [session, setSession] = useState<Session | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [deckListReady, setDeckListReady] = useState(false);
  const [reload, setReload] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [trialOpen, setTrialOpen] = useState(false);
  const [confirmReplace, setConfirmReplace] = useState(false);
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
        setSelections([playable[0]?.id ?? "", ""]);
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

  async function commit(
    next: () => Session | Promise<Session>,
    enterTable = false,
  ) {
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
        if (enterTable) {
          setPlaying(true);
          setConfirmReplace(false);
        }
      }
    } catch (reason) {
      if (mounted.current)
        setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      busy.current = false;
      if (mounted.current) setWorking(false);
    }
  }

  function start() {
    if (session && !confirmReplace) {
      setConfirmReplace(true);
      return;
    }
    void commit(async () => {
      const [one, two] = await Promise.all([
        loadDeck(selections[0]),
        selections[1] ? loadDeck(selections[1]) : practiceSeat,
      ]);
      return newSession(createMatch([one, two], first));
    }, true);
  }

  return (
    <section className="playtest-page">
      {import.meta.env.DEV && !playing && (
        <ForgePractice
          open={trialOpen}
          onOpenChange={setTrialOpen}
          canPlay={canPlay}
          disabled={working}
          imageCacheDir={settings.forge.imageCacheDir}
          decks={decks}
          decksReady={deckListReady}
          suggestedDeckId={
            decks.find(
              (deck) => deck.name === session?.match.players[0].deckName,
            )?.id
          }
        />
      )}
      {error && !trialOpen && (
        <div className="notice notice-error" role="alert">
          {error}
          {(!loaded || !deckListReady) && (
            <Button variant="outline" onClick={() => setReload((n) => n + 1)}>
              Retry
            </Button>
          )}
        </div>
      )}
      {trialOpen ? null : playing && session ? (
        <>
          <div className="pt-match-toolbar">
            <div>
              <small>Local table</small>
              <h2>
                {session.match.players[0].deckName} <span>vs.</span>{" "}
                {session.match.players[1].deckName}
              </h2>
            </div>
            <div>
              <GameHistory entries={session.history} />
              <Button
                variant="outline"
                disabled={working || !session.saved.actions.length}
                onClick={() => void commit(() => undoAction(session))}
              >
                <RotateCcw size={16} /> Undo
              </Button>
              <Button
                variant="outline"
                disabled={working}
                onClick={() => setPlaying(false)}
              >
                Leave table
              </Button>
            </div>
          </div>
          <fieldset disabled={working} className="pt-table-inputs">
            <Table
              key={session.saved.id}
              match={session.match}
              settings={settings}
              dispatch={(action) =>
                void commit(() => playAction(session, action))
              }
            />
          </fieldset>
        </>
      ) : (
        <>
          {loaded && session && (
            <div className="pt-resume panel">
              <div>
                <small>Saved table · Turn {session.match.turn}</small>
                <h2>
                  {session.match.players[0].deckName} <span>vs.</span>{" "}
                  {session.match.players[1].deckName}
                </h2>
              </div>
              <Button
                disabled={working}
                onClick={() => {
                  setPlaying(true);
                  setConfirmReplace(false);
                }}
              >
                Resume <ArrowRight size={16} />
              </Button>
            </div>
          )}
          <section className="panel pt-setup">
            <h2>Manual table</h2>
            <p>Practice a deck on your own, or play both sides of a matchup.</p>
            {deckListReady && !decks.length ? (
              <Button variant="outline" onClick={onDeckBuilder}>
                Build a deck <ArrowRight size={16} />
              </Button>
            ) : (
              <>
                <div className="pt-seats">
                  {([0, 1] as const).map((seat) => (
                    <label key={seat}>
                      Player {seat + 1}
                      <select
                        value={selections[seat]}
                        disabled={!deckListReady || working}
                        onChange={(event) => {
                          const ids: [string, string] = [...selections];
                          ids[seat] = event.target.value;
                          setSelections(ids);
                          if (!ids[1]) setFirst(0);
                          setConfirmReplace(false);
                        }}
                      >
                        {seat === 1 && (
                          <option value="">Empty seat (solo practice)</option>
                        )}
                        {decks.map((deck) => (
                          <option value={deck.id} key={deck.id}>
                            {deck.name} · {deck.mainCount} cards
                          </option>
                        ))}
                      </select>
                    </label>
                  ))}
                </div>
                <div className="pt-launch">
                  {selections[1] && (
                    <label>
                      Plays first
                      <select
                        value={first}
                        onChange={(e) =>
                          setFirst(Number(e.target.value) as Seat)
                        }
                        disabled={working}
                      >
                        <option value={0}>Player 1</option>
                        <option value={1}>Player 2</option>
                      </select>
                    </label>
                  )}
                  <Button
                    disabled={!loaded || !selections[0] || working}
                    onClick={start}
                  >
                    <Play size={15} />
                    {confirmReplace
                      ? "Replace saved table and start"
                      : "Start playtest"}
                  </Button>
                  {confirmReplace && (
                    <Button
                      variant="outline"
                      disabled={working}
                      onClick={() => setConfirmReplace(false)}
                    >
                      Cancel
                    </Button>
                  )}
                </div>
                {confirmReplace && (
                  <p role="status">
                    Starting a new table replaces this saved playtest and its
                    undo history.
                  </p>
                )}
              </>
            )}
          </section>
        </>
      )}
    </section>
  );
}
