import { useEffect, useRef, useState } from "react";
import { ArrowRight, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { appLifecycle } from "@/lib/app-lifecycle";
import type { DeckSummary } from "@/lib/types";
import ForgeBoard from "./ForgeBoard";
import { ManualHandoffDialog } from "./ManualHandoffDialog";
import { prepareForgeHandoff } from "./forge-handoff";
import { saveSession } from "./storage";
import type { Session } from "./session";
import type { Seat } from "./types";
import {
  chooseForge,
  setForgePriorityStop,
  startForge,
  stopForge,
  undoForge,
  viewForgeSeat,
  type ForgeMatch,
  type ForgeSeat,
  type PriorityStop,
} from "./forge-match";

function needsHandoff(match: ForgeMatch, viewer: ForgeSeat) {
  return (
    match.sharedSeats && match.stage === "decision" && match.actor !== viewer
  );
}

export default function Game({
  open,
  onOpenChange,
  canPlay,
  disabled,
  imageCacheDir,
  decks,
  decksReady,
  suggestedDeckId,
  onDeckBuilder,
  onManualSaved,
}: {
  open: boolean;
  onOpenChange: (value: boolean) => void;
  canPlay: () => boolean;
  disabled: boolean;
  imageCacheDir: string;
  decks: DeckSummary[];
  decksReady: boolean;
  suggestedDeckId?: string;
  onDeckBuilder: () => void;
  onManualSaved: (session: Session, viewer: Seat) => void;
}) {
  const [selection, setSelection] = useState("");
  const [opponentSelection, setOpponentSelection] = useState("same");
  const [viewer, setViewer] = useState<ForgeSeat>("player");
  const [state, setState] = useState<ForgeMatch | null>(null);
  const [recipient, setRecipient] = useState<ForgeSeat | null>(null);
  const [confirmManual, setConfirmManual] = useState(false);
  const [busy, setBusy] = useState<
    "play" | "switch" | "undo" | "handoff" | null
  >(null);
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
  const opponentDeck =
    opponentSelection === "same"
      ? selectedDeck
      : decks.find((deck) => deck.id === opponentSelection);
  const twoDecks = opponentSelection !== "solo";
  const shortDeck =
    (selectedDeck?.mainCount ?? 7) < 7 ||
    (twoDecks && (opponentDeck?.mainCount ?? 7) < 7);
  const canStart =
    !disabled && !!selectedDeck && !shortDeck && (!twoDecks || !!opponentDeck);

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
    setRecipient(null);
    onOpenChange(true);
    try {
      if (previous) await stopForge(previous);
      if (session.current !== id) return;
      const result = await startForge(
        id,
        selectedDeck!.id,
        twoDecks ? opponentDeck?.id : undefined,
      );
      if (session.current === id) {
        setState(result);
        setRecipient(needsHandoff(result, "player") ? result.actor : null);
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
    request: { action: string } | { switchTo: ForgeSeat } | { stop: PriorityStop } | "undo",
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
    const settingStop = !undo && "stop" in request;
    const nextViewer = switching ? request.switchTo : viewer;
    if (switching && !state.sharedSeats) return;
    if (undo && !state.canUndo) return;
    if (
      !switching &&
      !undo &&
      (recipient || state.stage !== "decision" || (!settingStop && needsHandoff(state, viewer)))
    )
      return;
    pending.current = true;
    setBusy(switching ? "switch" : undo ? "undo" : "play");
    setError(undefined);
    try {
      let result: ForgeMatch;
      if (switching) result = await viewForgeSeat(id, nextViewer);
      else if (settingStop) result = await setForgePriorityStop(id, viewer, state.revision, request.stop);
      else if (undo) result = await undoForge(id, viewer, state.revision);
      else result = await chooseForge(id, request.action, viewer, state.revision);
      if (session.current !== id) return;
      setState(result);
      setViewer(nextViewer);
      setRecipient(
        !switching && !settingStop && needsHandoff(result, nextViewer) ? result.actor : null,
      );
      if (undo) setRewinds((n) => n + 1);
    } catch (cause) {
      if (session.current === id)
        setError({
          message: switching
            ? `Couldn’t switch seats. Use the switch to retry. ${String(cause)}`
            : String(cause),
          restart: !switching && !undo && !settingStop,
        });
    } finally {
      if (session.current === id) {
        pending.current = false;
        setBusy(null);
      }
    }
  }

  async function handoff(previous: string | undefined) {
    const id = session.current;
    if (
      !id ||
      !state ||
      state.stage !== "decision" ||
      pending.current ||
      !canPlay() ||
      appLifecycle.isLocked()
    )
      throw new Error(
        "The game is busy. Try switching again when the current action finishes.",
      );
    pending.current = true;
    setBusy("handoff");
    try {
      const manual = await prepareForgeHandoff(id, state.revision);
      if (session.current !== id || !canPlay() || appLifecycle.isLocked())
        throw new Error("The game changed before it could be saved.");
      await saveSession(manual.saved, previous);
      if (session.current === id)
        onManualSaved(manual, (recipient ?? viewer) === "player" ? 0 : 1);
      // Leaving this component stops the Forge session after IndexedDB commits.
    } finally {
      if (session.current === id) {
        pending.current = false;
        setBusy(null);
      }
    }
  }

  function leave() {
    if (busy === "handoff") return;
    const previous = session.current;
    session.current = null;
    pending.current = false;
    restoreFocus.current = true;
    if (previous) void stopForge(previous).catch(() => {});
    setState(null);
    setBusy(null);
    setError(undefined);
    setConfirmManual(false);
    onOpenChange(false);
  }

  if (!open) {
    return (
      <section className="panel pt-setup" aria-labelledby="new-game-heading">
        <h2 id="new-game-heading">New game</h2>
        <div className="pt-seats">
          <label>
            Player 1 deck
            <select
              value={selectedDeck?.id ?? ""}
              disabled={disabled || !decks.length}
              onChange={(event) => setSelection(event.target.value)}
            >
              {!decks.length && (
                <option value="">
                  {decksReady ? "No saved decks" : "Loading decks…"}
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
              <option value="solo">Solo opponent · passes</option>
              {decks.map((deck) => (
                <option key={deck.id} value={deck.id}>
                  {deck.name} · {deck.mainCount} cards
                </option>
              ))}
            </select>
          </label>
        </div>
        {shortDeck && decks.length > 0 && (
          <p>
            Choose a deck with at least seven main-deck cards for each player.
          </p>
        )}
        <div className="pt-launch">
          <Button
            ref={launcher}
            disabled={!canStart}
            onClick={() => void start()}
          >
            Start game <ArrowRight size={15} />
          </Button>
          {decksReady && !decks.length && (
            <Button variant="outline" onClick={onDeckBuilder}>
              Build a deck
            </Button>
          )}
        </div>
      </section>
    );
  }

  const manualSwitch = state?.stage === "decision" && (
    <Button
      variant="outline"
      disabled={!!busy || !!error?.restart}
      onClick={() => setConfirmManual(true)}
    >
      Switch to manual play
    </Button>
  );

  return (
    <section className="game-page pt-forge" aria-label="Game">
      {!state && (
        <Button variant="outline" onClick={leave}>
          Leave game
        </Button>
      )}
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
              Restart game
            </Button>
          )}
        </div>
      )}
      {!state && !error && (
        <div className="panel pt-launch" role="status">
          <LoaderCircle size={17} aria-hidden /> Starting game…
        </div>
      )}
      {state && recipient && (
        <section className="pt-handoff" aria-label="Seat change">
          <h2>Pass to Player {recipient === "player" ? 1 : 2}</h2>
          <Button
            autoFocus
            disabled={!!busy}
            onClick={() => void updateTable({ switchTo: recipient })}
          >
            {busy === "switch" ? "Switching seats…" : "Reveal hand"}
          </Button>
          {manualSwitch}
          <Button
            variant="outline"
            onClick={leave}
            disabled={busy === "handoff"}
          >
            Leave game
          </Button>
        </section>
      )}
      {state && !recipient && (
        <ForgeBoard
          matchTools={{
            history: state.history,
            undoDisabled: !!busy || !!error?.restart || !state.canUndo,
            onUndo: () => void updateTable("undo"),
            onLeave: leave,
            leaveLabel: "Leave game",
            leaveDisabled: busy === "handoff",
            openingRecovery: error && (
              <div role="alert">
                {error.message}
                {error.restart && (
                  <Button onClick={() => void start()}>Restart game</Button>
                )}
              </div>
            ),
            manualSwitch,
          }}
          key={viewer + rewinds}
          state={state}
          viewer={viewer}
          onSwitch={
            state.sharedSeats
              ? () => setRecipient(viewer === "player" ? "opponent" : "player")
              : undefined
          }
          locked={!!busy || !!error?.restart}
          onChoose={(action) => void updateTable({ action })}
          onPriorityStop={(stop) => void updateTable({ stop })}
          replay={() => void start()}
          imageCacheDir={imageCacheDir}
        />
      )}
      {confirmManual && (
        <ManualHandoffDialog
          onCancel={() => setConfirmManual(false)}
          onConfirm={handoff}
        />
      )}
    </section>
  );
}
