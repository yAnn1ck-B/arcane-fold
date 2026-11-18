import { useEffect, useRef, useState, type Ref } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  ArrowRight,
  Check,
  Heart,
  LoaderCircle,
  Mountain,
  RotateCcw,
  Target,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { appLifecycle } from "@/lib/app-lifecycle";
import "./bolt-trial.css";

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

function LifeTotal({
  label,
  life,
  canTarget,
  targetLabel,
  choose,
  disabled,
  focusRef,
}: {
  label: string;
  life: number;
  canTarget: boolean;
  targetLabel: string;
  choose: () => void;
  disabled: boolean;
  focusRef?: Ref<HTMLButtonElement>;
}) {
  const content = (
    <>
      <span>{label}</span>
      <strong aria-label={`${life} life`}>
        <Heart size={18} aria-hidden />
        {life}
      </strong>
      {canTarget && <Target size={16} aria-hidden />}
    </>
  );
  return canTarget ? (
    <button
      ref={focusRef}
      type="button"
      aria-label={targetLabel}
      className="bolt-life bolt-target"
      disabled={disabled}
      onClick={choose}
    >
      {content}
    </button>
  ) : (
    <div className="bolt-life">{content}</div>
  );
}

function TrialCard({
  name,
  action,
  tapped,
  focusRef,
}: {
  name: string;
  action?: { label: string; disabled: boolean; activate: () => void };
  tapped?: boolean;
  focusRef?: Ref<HTMLButtonElement>;
}) {
  const land = name === "Mountain";
  const Icon = land ? Mountain : Zap;
  const content = (
    <>
      <Icon aria-hidden size={21} strokeWidth={1.6} />
      <span>
        <strong>{name}</strong>
        <small>
          {land ? "Basic land" : "Instant · One red mana"}
          {tapped !== undefined && (tapped ? " · Tapped" : " · Untapped")}
        </small>
      </span>
      {action && <ArrowRight aria-hidden size={16} />}
    </>
  );
  return action ? (
    <button
      ref={focusRef}
      type="button"
      className="bolt-card bolt-playable"
      disabled={action.disabled}
      onClick={action.activate}
      aria-label={action.label}
    >
      {content}
    </button>
  ) : (
    <div className="bolt-card">{content}</div>
  );
}

export default function ForgeBoltTrial({
  open,
  onOpenChange,
  canPlay,
  disabled,
}: {
  open: boolean;
  onOpenChange: (value: boolean) => void;
  canPlay: () => boolean;
  disabled: boolean;
}) {
  const [state, setState] = useState<TrialState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const session = useRef<string | null>(null);
  const requestPending = useRef(false);
  const nextButton = useRef<HTMLButtonElement>(null);
  const startButton = useRef<HTMLButtonElement>(null);
  const restoreLauncherFocus = useRef(false);

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
      <section className="panel pt-resume bolt-launch">
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
  return (
    <section className="bolt-trial" aria-label="Forge Lightning Bolt trial">
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
        <div className="panel bolt-loading" role="status">
          <LoaderCircle size={17} aria-hidden />
          Loading Forge and the starting position…
        </div>
      )}
      {state && (
        <>
          <div className="bolt-position panel">
            <header className="bolt-totals">
              <LifeTotal
                label="You"
                life={state.playerLife}
                canTarget={
                  state.stage === "chooseTarget" &&
                  state.legalTargets.includes("player")
                }
                targetLabel="Target yourself"
                choose={() => void act("targetPlayer")}
                disabled={locked}
              />
              <LifeTotal
                label="Opponent"
                life={state.opponentLife}
                canTarget={
                  state.stage === "chooseTarget" &&
                  state.legalTargets.includes("opponent")
                }
                targetLabel="Target opponent"
                choose={() => void act("targetOpponent")}
                disabled={locked}
                focusRef={error ? undefined : nextButton}
              />
            </header>
            <div className="bolt-prompt">
              <p role="status">
                {state.stage === "resolved" && <Check size={18} aria-hidden />}
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
            </div>
            <div className="bolt-row">
              <section className="bolt-zone" aria-label="Your hand">
                <h3>Your hand</h3>
                <div className="bolt-zone-cards">
                  {state.hand.length === 0 && <span>Empty</span>}
                  {state.hand.map((name) => {
                    const canPlayLand =
                      name === "Mountain" && state.stage === "ready";
                    const canCastBolt =
                      name === "Lightning Bolt" && state.stage === "landPlayed";
                    const action =
                      canPlayLand || canCastBolt
                        ? {
                            label: canPlayLand
                              ? "Play Mountain"
                              : "Cast Lightning Bolt",
                            disabled: locked,
                            activate: () =>
                              void act(
                                canPlayLand ? "playMountain" : "castBolt",
                              ),
                          }
                        : undefined;
                    return (
                      <TrialCard
                        key={name}
                        name={name}
                        action={action}
                        focusRef={action && !error ? nextButton : undefined}
                      />
                    );
                  })}
                </div>
              </section>
              <section className="bolt-zone" aria-label="Your battlefield">
                <h3>Your battlefield</h3>
                <div className="bolt-zone-cards">
                  {state.battlefield.length === 0 && <span>Empty</span>}
                  {state.battlefield.map((name) => (
                    <TrialCard
                      key={name}
                      name={name}
                      tapped={state.mountainTapped}
                    />
                  ))}
                </div>
              </section>
            </div>
            <dl className="bolt-piles">
              <div>
                <dt>Stack</dt>
                <dd>
                  {state.stack.join(", ") || "Empty"}
                  {state.target && state.stack.length > 0 && (
                    <small className="bolt-stack-target">
                      <Target size={13} aria-hidden />
                      {state.target === "opponent" ? "Opponent" : "You"}
                    </small>
                  )}
                </dd>
              </div>
              <div>
                <dt>Your graveyard</dt>
                <dd>{state.graveyard.join(", ") || "Empty"}</dd>
              </div>
              <div>
                <dt>Mana pool</dt>
                <dd>{state.mana}</dd>
              </div>
            </dl>
          </div>
        </>
      )}
    </section>
  );
}
