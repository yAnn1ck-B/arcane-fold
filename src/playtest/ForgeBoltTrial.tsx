import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  ArrowRight,
  Droplet,
  LoaderCircle,
  RotateCcw,
  Target,
  ImageOff,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { appLifecycle } from "@/lib/app-lifecycle";
import CardImage from "@/components/CardImage";
import { database } from "@/services/database";
import { LifeValue, StackPanel, TableBoard, TableSeat } from "./TableBoard";
import { TableCard } from "./TableCards";

type Stage =
  | "ready"
  | "landPlayed"
  | "chooseTarget"
  | "opponentPriority"
  | "resolved";
type Action =
  | "playMountain"
  | "castBolt"
  | "targetPlayer"
  | "targetOpponent"
  | "passPriority";
type Seat = "player" | "opponent";

interface TrialState {
  stage: Stage;
  playerLife: number;
  opponentLife: number;
  hand: string[];
  battlefield: string[];
  opponentBattlefield?: string[];
  stack: string[];
  graveyard: string[];
  mountainTapped: boolean;
  mana: number;
  legalTargets: Seat[];
  target: Seat | null;
}

const prompts: Record<Stage, string> = {
  ready: "Play Mountain from your hand.",
  landPlayed: "Cast Lightning Bolt from your hand.",
  chooseTarget:
    "Choose a target. Aim at the opponent to deal three damage to them.",
  opponentPriority:
    "The opponent has priority. Pass to let Lightning Bolt resolve.",
  resolved: "Lightning Bolt resolved.",
};

function stopTrial(sessionId: string) {
  return invoke<void>("stop_bolt_trial", { sessionId });
}

type Artwork = { id: string; name: string };

async function loadTrialArtwork() {
  const db = await database();
  const cards = await Promise.all(
    ["Mountain", "Lightning Bolt"].map(async (name) => {
      // The fixed position uses representative art from Magic 2010 when available.
      const [card] = await db.select<Artwork[]>(
        `SELECT id, name FROM cards WHERE name = ? COLLATE NOCASE AND image_uri IS NOT NULL
       ORDER BY (set_code = 'm10' COLLATE NOCASE) DESC, set_code, collector_number, id LIMIT 1`,
        [name],
      );
      return card;
    }),
  );
  return Object.fromEntries(
    cards.filter((card) => !!card).map((card) => [card.name, card]),
  );
}

export default function ForgeBoltTrial({
  open,
  onOpenChange,
  canPlay,
  disabled,
  imageCacheDir,
}: {
  open: boolean;
  onOpenChange: (value: boolean) => void;
  canPlay: () => boolean;
  disabled: boolean;
  imageCacheDir: string;
}) {
  const [state, setState] = useState<TrialState | null>(null);
  const [art, setArt] = useState<Record<string, Artwork>>({});
  const [showGraveyard, setShowGraveyard] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const session = useRef<string | null>(null);
  const requestPending = useRef(false);
  const nextButton = useRef<HTMLButtonElement>(null);
  const startButton = useRef<HTMLButtonElement>(null);
  const restoreLauncherFocus = useRef(false);

  useEffect(() => {
    if (!open) return;
    let active = true;
    void loadTrialArtwork()
      .then((cards) => {
        if (active) setArt(cards);
      })
      .catch(() => {
        // The fixture can be played while the local artwork catalog is unavailable.
      });
    return () => {
      active = false;
    };
  }, [open]);

  useEffect(() => {
    if (open && !busy) nextButton.current?.focus();
    if (!open && restoreLauncherFocus.current) {
      restoreLauncherFocus.current = false;
      startButton.current?.focus();
    }
  }, [open, busy, state?.stage, error]);

  useEffect(
    () => () => {
      const previous = session.current;
      session.current = null;
      if (previous) void stopTrial(previous).catch(() => {});
    },
    [],
  );

  async function start() {
    if (requestPending.current || !canPlay() || appLifecycle.isLocked()) return;
    const previous = session.current;
    const id = crypto.randomUUID();
    session.current = id;
    requestPending.current = true;
    setBusy(true);
    setState(null);
    setShowGraveyard(false);
    setError("");
    onOpenChange(true);
    try {
      if (previous) await stopTrial(previous);
      if (session.current !== id) return;
      const initial = await invoke<TrialState>("start_bolt_trial", {
        sessionId: id,
      });
      if (session.current === id) setState(initial);
      else await stopTrial(id);
    } catch (cause) {
      if (session.current === id) setError(String(cause));
    } finally {
      if (session.current === id) {
        requestPending.current = false;
        setBusy(false);
      }
    }
  }

  async function act(action: Action) {
    const id = session.current;
    if (
      !id ||
      requestPending.current ||
      error ||
      !canPlay() ||
      appLifecycle.isLocked()
    )
      return;
    requestPending.current = true;
    setBusy(true);
    try {
      const next = await invoke<TrialState>("act_bolt_trial", {
        sessionId: id,
        action,
      });
      if (session.current === id) setState(next);
    } catch (cause) {
      if (session.current === id) setError(String(cause));
    } finally {
      if (session.current === id) {
        requestPending.current = false;
        setBusy(false);
      }
    }
  }

  function leave() {
    const previous = session.current;
    session.current = null;
    requestPending.current = false;
    restoreLauncherFocus.current = true;
    if (previous) void stopTrial(previous).catch(() => {});
    onOpenChange(false);
  }

  if (!open)
    return (
      <section className="panel pt-resume">
        <div>
          <small>Forge playtest</small>
          <h2>Lightning Bolt trial</h2>
          <p>
            Play a Mountain, cast Lightning Bolt, and pass priority to resolve
            it.
          </p>
        </div>
        <Button
          ref={startButton}
          disabled={disabled}
          onClick={() => void start()}
        >
          Start trial <ArrowRight size={15} />
        </Button>
      </section>
    );

  const locked = busy || !!error;
  function tableCard(
    name: string,
    action?: "playMountain" | "castBolt",
    tapped?: boolean,
  ) {
    const card = art[name];
    const label =
      action === "playMountain"
        ? "Play Mountain"
        : action === "castBolt"
          ? "Cast Lightning Bolt"
          : tapped === undefined
            ? name
            : `${name}, ${tapped ? "Tapped" : "Untapped"}`;
    return (
      <TableCard
        key={name}
        name={name}
        label={label}
        tapped={tapped}
        disabled={locked}
        focusRef={action && !error ? nextButton : undefined}
        onClick={action ? () => void act(action) : undefined}
        art={
          card ? (
            <CardImage card={card} imageCacheDir={imageCacheDir} />
          ) : (
            <div className="card-image">
              <div className="card-image-placeholder">
                <ImageOff size={20} aria-hidden />
                <span>{name}</span>
              </div>
            </div>
          )
        }
      />
    );
  }

  return (
    <section className="playtest-page" aria-label="Forge Lightning Bolt trial">
      <div className="pt-match-toolbar">
        <div>
          <small>Forge playtest</small>
          <h2>Lightning Bolt trial</h2>
        </div>
        <div>
          <Button variant="outline" onClick={leave}>
            Leave trial
          </Button>
        </div>
      </div>
      {error && (
        <div className="notice notice-error" role="alert">
          <span>{error}</span>
          <Button
            ref={nextButton}
            variant="outline"
            disabled={busy}
            onClick={() => void start()}
          >
            Restart trial
          </Button>
        </div>
      )}
      {!state && !error && (
        <div className="panel pt-launch" role="status">
          <LoaderCircle size={17} aria-hidden />
          Loading Forge and the starting position…
        </div>
      )}
      {state && (
        <TableBoard
          label="Forge playtest table"
          toolbar={
            <>
              <p className="ptc ptc-turn" role="status">
                {prompts[state.stage]}
              </p>
              {state.stage === "opponentPriority" && (
                <Button
                  ref={error ? undefined : nextButton}
                  disabled={locked}
                  onClick={() => void act("passPriority")}
                >
                  Pass priority <ArrowRight size={15} />
                </Button>
              )}
              {state.stage === "resolved" && (
                <Button
                  ref={error ? undefined : nextButton}
                  variant="outline"
                  disabled={locked}
                  onClick={() => void start()}
                >
                  <RotateCcw size={15} /> Replay trial
                </Button>
              )}
            </>
          }
          seats={(["opponent", "player"] as const).map((seat) => {
            const own = seat === "player";
            const life = (
              <LifeValue life={own ? state.playerLife : state.opponentLife} />
            );
            const canTarget =
              state.stage === "chooseTarget" &&
              state.legalTargets.includes(seat);
            return (
              <TableSeat
                key={seat}
                own={own}
                label={own ? "Player 1" : "Player 2"}
                title={own ? "You" : "Opponent"}
                piles={
                  own && (
                    <button
                      type="button"
                      aria-label={`Your graveyard, ${state.graveyard.length} ${state.graveyard.length === 1 ? "card" : "cards"}`}
                      aria-expanded={showGraveyard}
                      onClick={() => setShowGraveyard(!showGraveyard)}
                    >
                      Graveyard <b>{state.graveyard.length}</b>
                    </button>
                  )
                }
                resources={
                  <div className="ptc ptc-player">
                    <div className="ptc-row">
                      {canTarget ? (
                        <button
                          type="button"
                          className="ptc-accent"
                          ref={!own && !error ? nextButton : undefined}
                          aria-label={
                            own ? "Target yourself" : "Target opponent"
                          }
                          disabled={locked}
                          onClick={() =>
                            void act(own ? "targetPlayer" : "targetOpponent")
                          }
                        >
                          <Target size={14} /> Target{" "}
                          {own ? "yourself" : "opponent"} · {life}
                        </button>
                      ) : (
                        <div className="ptc-life">{life}</div>
                      )}
                      {own && (
                        <span className="pt-subtle">
                          <Droplet size={14} /> Mana pool <b>{state.mana}</b>
                        </span>
                      )}
                    </div>
                  </div>
                }
                cards={
                  own
                    ? state.battlefield.map((name) =>
                        tableCard(name, undefined, state.mountainTapped),
                      )
                    : state.opponentBattlefield?.map((name) => tableCard(name))
                }
              />
            );
          })}
          handCount={state.hand.length}
          hand={state.hand.map((name) =>
            tableCard(
              name,
              state.stage === "ready" && name === "Mountain"
                ? "playMountain"
                : state.stage === "landPlayed" && name === "Lightning Bolt"
                  ? "castBolt"
                  : undefined,
            ),
          )}
          stack={
            <StackPanel count={state.stack.length}>
              {state.stack.length > 0 && (
                <ol className="ptc-stack-list">
                  {state.stack.map((name) => (
                    <li className="ptc-stack-entry" key={name}>
                      <div className="ptc-stack-meta">
                        <span>Top</span> · spell · P1
                      </div>
                      <strong>{name}</strong>
                      {state.target && (
                        <small>
                          Targeting{" "}
                          {state.target === "opponent" ? "opponent" : "you"}
                        </small>
                      )}
                    </li>
                  ))}
                </ol>
              )}
            </StackPanel>
          }
        >
          {showGraveyard && (
            <section className="pt-pile-panel" aria-label="Your graveyard">
              <header className="pt-pile-heading">
                <div>
                  <small>Player 1</small>
                  <h3>
                    Graveyard <small>{state.graveyard.length}</small>
                  </h3>
                </div>
                <button
                  type="button"
                  className="pt-btn"
                  onClick={() => setShowGraveyard(false)}
                >
                  Close zone
                </button>
              </header>
              {state.graveyard.length ? (
                <div className="pt-field">
                  {state.graveyard.map((name) => tableCard(name))}
                </div>
              ) : (
                <p className="pt-subtle">This zone is empty.</p>
              )}
            </section>
          )}
        </TableBoard>
      )}
    </section>
  );
}
