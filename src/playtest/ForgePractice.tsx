import { useEffect, useRef, useState } from "react";
import { ArrowRight, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { appLifecycle } from "@/lib/app-lifecycle";
import type { DeckSummary } from "@/lib/types";
import ForgeBoard from "./ForgeBoard";
import {
  chooseForge,
  startForge,
  stopForge,
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
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
  const switchSeats =
    twoDecks ||
    scenario === "growth" ||
    scenario === "response" ||
    scenario === "combat" ||
    scenario === "library";
  const needsSwitch =
    !!state &&
    switchSeats &&
    state.stage === "decision" &&
    viewer !== state.actor;
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
    if (open && error) retry.current?.focus();
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
    setBusy(true);
    setError("");
    setState(null);
    setViewer("player");
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
      if (session.current === id) setState(result);
      else await stopForge(id);
    } catch (cause) {
      if (session.current === id) setError(String(cause));
    } finally {
      if (session.current === id) {
        pending.current = false;
        setBusy(false);
      }
    }
  }

  async function choose(action: string) {
    const id = session.current;
    if (
      !id ||
      needsSwitch ||
      pending.current ||
      error ||
      !canPlay() ||
      appLifecycle.isLocked()
    )
      return;
    pending.current = true;
    setBusy(true);
    try {
      const result = await chooseForge(id, scenario, action);
      if (session.current === id) setState(result);
    } catch (cause) {
      if (session.current === id) setError(String(cause));
    } finally {
      if (session.current === id) {
        pending.current = false;
        setBusy(false);
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
    setBusy(false);
    setError("");
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
        <Button variant="outline" onClick={leave}>
          {isDeck ? "Leave practice" : "Leave trial"}
        </Button>
      </div>
      {error && (
        <div className="notice notice-error" role="alert">
          <span>{error}</span>
          <Button
            ref={retry}
            variant="outline"
            disabled={busy}
            onClick={() => void start()}
          >
            {isDeck ? "Restart practice" : "Restart trial"}
          </Button>
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
          key={viewer + (needsSwitch ? "-handoff" : "")}
          state={
            needsSwitch
              ? {
                  ...state,
                  prompt: `Player ${state.actor === "player" ? 1 : 2} has a decision.`,
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
          sharedSeats={switchSeats}
          onSwitch={needsSwitch ? () => setViewer(state.actor) : undefined}
          scenario={scenario}
          locked={busy || !!error}
          onChoose={(action) => void choose(action)}
          replay={() => void start()}
          imageCacheDir={imageCacheDir}
        />
      )}
    </section>
  );
}
