import { useEffect, useRef, useState } from "react";
import { ArrowRight, LoaderCircle, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { appLifecycle } from "@/lib/app-lifecycle";
import type { DeckSummary } from "@/lib/types";
import ForgeBoard from "./ForgeBoard";
import { GameHistory } from "./GameHistory";
import {
  chooseForge,
  startForge,
  stopForge,
  undoForge,
  viewForgeSeat,
  type ForgeMatch,
  type ForgeSeat,
  type Scenario,
} from "./forge-match";

const positions: Record<Scenario, { label: string; description: string }> = {
  deck: {
    label: "Saved deck practice",
    description:
      "Play both decks on this table, or choose solo practice for an opponent who passes.",
  },
  bolt: {
    label: "Lightning Bolt",
    description: "Play Mountain and deal three damage with Lightning Bolt.",
  },
  response: {
    label: "Counterspell response",
    description:
      "Cast Lightning Bolt, then choose whether the opponent counters it.",
  },
  combat: {
    label: "Creature combat",
    description:
      "Choose an attacker and a blocker, then let Forge resolve combat damage.",
  },
  growth: {
    label: "Giant Growth in combat",
    description:
      "Attack with Grizzly Bears, choose a block as Player 2, then decide whether to cast Giant Growth before combat damage.",
  },
  library: {
    label: "Library search and activated abilities",
    description:
      "Try both modes of Bushwhack, search with Evolving Wilds or Cultivate, or activate Mild-Mannered Librarian.",
  },
};

function needsHandoff(match: ForgeMatch, viewer: ForgeSeat) {
  return (
    match.sharedSeats && match.stage === "decision" && match.actor !== viewer
  );
}

export default function ForgePractice({
  open,
  onOpenChange,
  canPlay,
  disabled,
  imageCacheDir,
  decks,
  decksReady,
  suggestedDeckId,
}: {
  open: boolean;
  onOpenChange: (value: boolean) => void;
  canPlay: () => boolean;
  disabled: boolean;
  imageCacheDir: string;
  decks: DeckSummary[];
  decksReady: boolean;
  suggestedDeckId?: string;
}) {
  const [scenario, setScenario] = useState<Scenario>("deck");
  const [selection, setSelection] = useState("");
  const [opponentSelection, setOpponentSelection] = useState("same");
  const [viewer, setViewer] = useState<ForgeSeat>("player");
  const [state, setState] = useState<ForgeMatch | null>(null);
  const [handHidden, setHandHidden] = useState(false);
  const [busy, setBusy] = useState<"play" | "switch" | "undo" | null>(null);
  const [rewinds, setRewinds] = useState(0);
  const [error, setError] = useState<{ message: string; restart: boolean }>();
  const session = useRef<string | null>(null);
  const pending = useRef(false);
  const launcher = useRef<HTMLButtonElement>(null);
  const retry = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  const selectedDeck =
    decks.find((deck) => deck.id === selection) ??
    decks.find((deck) => deck.id === suggestedDeckId) ??
    decks[0];
  const isDeck = scenario === "deck";
  const opponentDeck =
    opponentSelection === "same"
      ? selectedDeck
      : decks.find((deck) => deck.id === opponentSelection);
  const twoDecks = isDeck && opponentSelection !== "solo";
  const shortDeck =
    isDeck &&
    ((selectedDeck?.mainCount ?? 7) < 7 ||
      (twoDecks && (opponentDeck?.mainCount ?? 7) < 7));
  const canStart =
    !disabled &&
    (!isDeck ||
      (!!selectedDeck && !shortDeck && (!twoDecks || !!opponentDeck)));

  useEffect(() => {
    if (!open && restoreFocus.current) {
      restoreFocus.current = false;
      launcher.current?.focus();
    }
    if (open && error?.restart) retry.current?.focus();
  }, [open, error]);

  useEffect(
    () => () => {
      const previous = session.current;
      session.current = null;
      if (previous) void stopForge(previous).catch(() => {});
    },
    [],
  );

  async function start() {
    if (!canStart || pending.current || !canPlay() || appLifecycle.isLocked())
      return;
    const previous = session.current;
    const id = crypto.randomUUID();
    session.current = id;
    pending.current = true;
    setBusy("play");
    setError(undefined);
    setState(null);
    setViewer("player");
    setHandHidden(false);
    onOpenChange(true);
    try {
      if (previous) await stopForge(previous);
      if (session.current !== id) return;
      const result = await startForge(
        id,
        scenario,
        isDeck ? selectedDeck?.id : undefined,
        twoDecks ? opponentDeck?.id : undefined,
      );
      if (session.current === id) {
        setState(result);
        setHandHidden(needsHandoff(result, "player"));
      } else await stopForge(id);
    } catch (cause) {
      if (session.current === id)
        setError({ message: String(cause), restart: true });
    } finally {
      if (session.current === id) {
        pending.current = false;
        setBusy(null);
      }
    }
  }

  async function updateTable(
    request: { action: string } | { switchTo: ForgeSeat } | "undo",
  ) {
    const id = session.current;
    if (
      !id ||
      !state ||
      pending.current ||
      error?.restart ||
      !canPlay() ||
      appLifecycle.isLocked()
    )
      return;
    const undo = request === "undo";
    const switching = !undo && "switchTo" in request;
    const nextViewer = switching ? request.switchTo : viewer;
    if (switching && !state.sharedSeats) return;
    if (undo && !state.canUndo) return;
    if (
      !switching &&
      !undo &&
      (handHidden || state.stage !== "decision" || needsHandoff(state, viewer))
    )
      return;
    pending.current = true;
    setBusy(switching ? "switch" : undo ? "undo" : "play");
    setError(undefined);
    // Conceal the outgoing hand and close private dialogs as soon as the device changes hands.
    if (switching) setHandHidden(true);
    try {
      const result = switching
        ? await viewForgeSeat(id, nextViewer)
        : undo
          ? await undoForge(id, scenario, viewer, state.revision)
          : await chooseForge(
              id,
              scenario,
              request.action,
              viewer,
              state.revision,
            );
      if (session.current !== id) return;
      setState(result);
      setViewer(nextViewer);
      setHandHidden(!switching && needsHandoff(result, nextViewer));
      if (undo) setRewinds((n) => n + 1);
    } catch (cause) {
      if (session.current === id)
        setError({
          message: switching
            ? `Couldn’t switch seats. Use the switch to retry. ${String(cause)}`
            : String(cause),
          restart: !switching && !undo,
        });
    } finally {
      if (session.current === id) {
        pending.current = false;
        setBusy(null);
      }
    }
  }

  function leave() {
    const previous = session.current;
    session.current = null;
    pending.current = false;
    restoreFocus.current = true;
    if (previous) void stopForge(previous).catch(() => {});
    setState(null);
    setBusy(null);
    setError(undefined);
    onOpenChange(false);
  }

  if (!open) {
    return (
      <section className="panel pt-setup" aria-label="Forge practice">
        <h2>Forge practice</h2>
        <div className="pt-seats">
          <label>
            Starting position
            <select
              value={scenario}
              disabled={disabled}
              onChange={(event) => setScenario(event.target.value as Scenario)}
            >
              {Object.entries(positions).map(([value, position]) => (
                <option key={value} value={value}>
                  {position.label}
                </option>
              ))}
            </select>
          </label>
          {isDeck && (
            <>
              <label>
                Player 1 deck
                <select
                  value={selectedDeck?.id ?? ""}
                  disabled={disabled || !decks.length}
                  onChange={(event) => setSelection(event.target.value)}
                >
                  {!decks.length && (
                    <option value="">
                      {decksReady
                        ? "No saved decks available"
                        : "Loading decks…"}
                    </option>
                  )}
                  {decks.map((deck) => (
                    <option key={deck.id} value={deck.id}>
                      {deck.name} · {deck.mainCount} cards
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Player 2 deck
                <select
                  value={opponentSelection}
                  disabled={disabled || !decks.length}
                  onChange={(event) => setOpponentSelection(event.target.value)}
                >
                  <option value="same">Same deck as Player 1</option>
                  <option value="solo">Solo practice · opponent passes</option>
                  {decks.map((deck) => (
                    <option key={deck.id} value={deck.id}>
                      {deck.name} · {deck.mainCount} cards
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}
        </div>
        <p>
          {shortDeck
            ? "Choose a deck with at least seven main-deck cards for an opening hand."
            : positions[scenario].description}
        </p>
        <Button
          ref={launcher}
          disabled={!canStart}
          onClick={() => void start()}
        >
          {isDeck ? "Start practice" : "Start trial"} <ArrowRight size={15} />
        </Button>
      </section>
    );
  }

  const title = isDeck
    ? twoDecks
      ? `${selectedDeck?.name} vs. ${opponentDeck?.name}`
      : selectedDeck?.name
    : scenario === "bolt"
      ? "Lightning Bolt trial"
      : positions[scenario].label;
  return (
    <section
      className="playtest-page pt-forge"
      aria-label={isDeck ? "Forge deck practice" : `Forge ${title}`}
    >
      <div className="pt-match-toolbar">
        <div>
          <small>Forge practice</small>
          <h2>{title}</h2>
        </div>
        <div>
          {state && (
            <>
              <GameHistory entries={state.history} />
              <Button
                variant="outline"
                disabled={!!busy || !!error?.restart || !state.canUndo}
                onClick={() => void updateTable("undo")}
                aria-busy={busy === "undo"}
              >
                {busy === "undo" ? (
                  <LoaderCircle size={16} />
                ) : (
                  <RotateCcw size={16} />
                )}
                {busy === "undo" ? "Undoing…" : "Undo"}
              </Button>
            </>
          )}
          <Button variant="outline" onClick={leave}>
            {isDeck ? "Leave practice" : "Leave trial"}
          </Button>
        </div>
      </div>
      {error && (
        <div className="notice notice-error" role="alert">
          <span>{error.message}</span>
          {error.restart && (
            <Button
              ref={retry}
              variant="outline"
              disabled={!!busy}
              onClick={() => void start()}
            >
              {isDeck ? "Restart practice" : "Restart trial"}
            </Button>
          )}
        </div>
      )}
      {!state && !error && (
        <div className="panel pt-launch" role="status">
          <LoaderCircle size={17} aria-hidden /> Loading Forge and the starting
          position…
        </div>
      )}
      {state && (
        <ForgeBoard
          key={viewer + rewinds + (handHidden ? "-handoff" : "")}
          state={
            handHidden
              ? {
                  ...state,
                  prompt:
                    busy === "switch"
                      ? "Switching seats…"
                      : state.stage === "finished"
                        ? state.prompt
                        : `Player ${state.actor === "player" ? 1 : 2} has a decision.`,
                  choices: [],
                  librarySearch: undefined,
                  revealedToYou: undefined,
                  players: {
                    player: { ...state.players.player, hand: [] },
                    opponent: { ...state.players.opponent, hand: [] },
                  },
                }
              : state
          }
          viewer={viewer}
          handHidden={handHidden}
          onSwitch={
            state.sharedSeats
              ? () =>
                  void updateTable({
                    switchTo: viewer === "player" ? "opponent" : "player",
                  })
              : undefined
          }
          scenario={scenario}
          locked={!!busy || !!error?.restart}
          onChoose={(action) => void updateTable({ action })}
          replay={() => void start()}
          imageCacheDir={imageCacheDir}
        />
      )}
    </section>
  );
}
