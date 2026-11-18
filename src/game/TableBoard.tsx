import {
  ArrowLeftRight,
  Crown,
  Hand,
  Heart,
  Layers,
  LogOut,
  Orbit,
  PanelRightClose,
  ScrollText,
  Skull,
  SquareStack,
  Undo2,
} from "lucide-react";
import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react";
import { GameHistory } from "./GameHistory";
import type { HistoryEntry } from "./types";
import "./table.css";
import "./controls.css";

export interface MatchTools {
  history: HistoryEntry[];
  onUndo: () => void;
  undoDisabled: boolean;
  onLeave: () => void;
  leaveLabel: string;
  leaveDisabled?: boolean;
  contextLabel?: string;
  manualSwitch?: ReactNode;
  openingRecovery?: ReactNode;
}

const zoneIcons = {
  library: SquareStack,
  hand: Hand,
  graveyard: Skull,
  exile: Orbit,
  command: Crown,
};

export function ZoneCounter({
  zone,
  count,
  label,
  onOpen,
  open,
}: {
  zone: keyof typeof zoneIcons;
  count: number;
  label: string;
  onOpen?: () => void;
  open?: boolean;
}) {
  const Icon = zoneIcons[zone];
  const content = (
    <>
      <Icon size={15} aria-hidden />
      <b>{count}</b>
    </>
  );
  return onOpen ? (
    <button
      type="button"
      className="pt-zone-chip"
      data-hint={label}
      aria-label={label}
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={onOpen}
    >
      {content}
    </button>
  ) : (
    <span
      className="pt-zone-chip"
      tabIndex={0}
      role="img"
      data-hint={label}
      aria-label={label}
    >
      {content}
    </span>
  );
}

export function SwitchPlayer({
  player,
  onSwitch,
  disabled,
  focusRef,
}: {
  player: number;
  onSwitch: () => void;
  disabled?: boolean;
  focusRef?: Ref<HTMLButtonElement>;
}) {
  return (
    <button
      type="button"
      className="pt-seat-switch"
      onClick={onSwitch}
      disabled={disabled}
      ref={focusRef}
      aria-label={`Switch to Player ${player}`}
      data-hint={`Switch to Player ${player}`}
    >
      <ArrowLeftRight size={15} aria-hidden /> P{player}
    </button>
  );
}

export function TableBoard({
  label,
  toolbar,
  seats,
  handCount,
  handLabel = "Your hand",
  hand,
  stack,
  stackCount,
  matchTools,
  children,
}: {
  label: string;
  toolbar: ReactNode;
  seats: ReactNode;
  handCount: number;
  handLabel?: string;
  hand: ReactNode[];
  stack: ReactNode;
  stackCount: number;
  matchTools: MatchTools;
  children?: ReactNode;
}) {
  type Panel = "stack" | "log";
  // New stack activity opens the right rail. A manually opened rail stays in
  // place while the player composes an entry or looks back through the log.
  const [selection, setSelection] = useState<Panel | "auto" | "closed">("auto");
  const [previousCount, setPreviousCount] = useState(stackCount);
  if (previousCount !== stackCount) {
    setPreviousCount(stackCount);
    if (selection === "closed" && stackCount > previousCount)
      setSelection("auto");
  }
  const panel: Panel | null =
    selection === "auto"
      ? stackCount > 0
        ? "stack"
        : null
      : selection === "closed"
        ? null
        : selection;
  const panelId = useId();
  const stackTrigger = useRef<HTMLButtonElement>(null);
  const logTrigger = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const focusPanel = useRef(false);
  function closePanel() {
    (panel === "log" ? logTrigger : stackTrigger).current?.focus({
      preventScroll: true,
    });
    setSelection("closed");
  }
  function togglePanel(next: Panel) {
    if (next === panel) return closePanel();
    focusPanel.current = true;
    setSelection(next);
  }
  useLayoutEffect(() => {
    if (panel && focusPanel.current)
      closeButton.current?.focus({ preventScroll: true });
    focusPanel.current = false;
  }, [panel]);
  return (
    <section
      className="pt-table"
      aria-label={label}
      onKeyDown={(event) => {
        if (
          panel &&
          event.key === "Escape" &&
          !event.defaultPrevented &&
          !document.querySelector("dialog[open]")
        ) {
          event.preventDefault();
          closePanel();
        }
      }}
    >
      <div className="pt-turnbar">
        {matchTools.contextLabel && (
          <span className="pt-context">{matchTools.contextLabel}</span>
        )}
        {toolbar}
        <div className="pt-table-tools" role="group" aria-label="Table tools">
          {matchTools.manualSwitch}
          <button
            type="button"
            className="pt-tool"
            ref={stackTrigger}
            aria-label={`Stack, ${stackCount} ${stackCount === 1 ? "entry" : "entries"}`}
            data-hint="Stack"
            aria-controls={panelId}
            aria-expanded={panel === "stack"}
            onClick={() => togglePanel("stack")}
          >
            <Layers size={16} aria-hidden />
            <b>{stackCount}</b>
          </button>
          <button
            type="button"
            className="pt-tool"
            ref={logTrigger}
            aria-label="Game log"
            data-hint="Game log"
            aria-controls={panelId}
            aria-expanded={panel === "log"}
            onClick={() => togglePanel("log")}
          >
            <ScrollText size={16} aria-hidden />
          </button>
          <button
            type="button"
            className="pt-tool"
            aria-label="Undo"
            data-hint="Undo"
            disabled={matchTools.undoDisabled}
            onClick={matchTools.onUndo}
          >
            <Undo2 size={16} aria-hidden />
          </button>
          <button
            type="button"
            className="pt-tool"
            aria-label={matchTools.leaveLabel}
            data-hint={matchTools.leaveLabel}
            disabled={matchTools.leaveDisabled}
            onClick={matchTools.onLeave}
          >
            <LogOut size={16} aria-hidden />
          </button>
        </div>
      </div>
      <div className={`pt-table-layout${panel ? " pt-with-panel" : ""}`}>
        <div className="pt-arena">
          {seats}
          <section className="pt-hand" aria-label={handLabel}>
            <div className="pt-zone-header">
              <h3>
                {handLabel} <small>{handCount}</small>
              </h3>
            </div>
            <div className="pt-field">
              {hand.length ? (
                hand
              ) : (
                <span className="pt-empty">No cards in hand</span>
              )}
            </div>
          </section>
        </div>
        <aside
          className="pt-side-panel"
          id={panelId}
          aria-label={panel === "log" ? "Game log" : "Shared stack"}
          hidden={!panel}
        >
          <header className="pt-panel-header">
            <h2>
              {panel === "log" ? (
                <>
                  <ScrollText size={16} aria-hidden />
                  Game log
                </>
              ) : (
                <>
                  <Layers size={16} aria-hidden />
                  Stack <small>{stackCount}</small>
                </>
              )}
            </h2>
            <button
              type="button"
              className="pt-tool"
              ref={closeButton}
              onClick={closePanel}
              data-hint="Close panel"
              aria-label="Close panel"
            >
              <PanelRightClose size={16} aria-hidden />
            </button>
          </header>
          <div className="pt-panel-body" hidden={panel !== "stack"}>
            {stack}
          </div>
          {panel === "log" && <GameHistory entries={matchTools.history} />}
        </aside>
      </div>
      {children}
    </section>
  );
}

export function TableSeat({
  own,
  player,
  piles,
  resources,
  battlefieldAction,
  battlefieldForm,
  cards,
}: {
  own: boolean;
  player: number;
  piles?: ReactNode;
  resources: ReactNode;
  battlefieldAction?: ReactNode;
  battlefieldForm?: ReactNode;
  cards?: ReactNode[];
}) {
  return (
    <section
      className={`pt-seat ${own ? "pt-own" : "pt-opponent"}`}
      aria-label={`Player ${player} battlefield`}
    >
      <header className="pt-seat-heading">
        <h2 className="pt-seat-title">
          <b>P{player}</b> {own ? "You" : "Opponent"}
        </h2>
        {resources}
        {piles && (
          <div
            className="pt-piles"
            role="group"
            aria-label={`Player ${player} zones`}
          >
            {piles}
          </div>
        )}
        {battlefieldAction}
      </header>
      {battlefieldForm}
      <div className="pt-field">
        {cards?.length ? (
          cards
        ) : (
          <span className="pt-empty">
            {cards ? "Empty battlefield" : "Battlefield unavailable"}
          </span>
        )}
      </div>
    </section>
  );
}

export function LifeValue({ life }: { life: number }) {
  return (
    <strong aria-label={`${life} life`}>
      <Heart size={15} aria-hidden /> {life}
    </strong>
  );
}

export function StackPanel({
  count,
  children,
}: {
  count: number;
  children: ReactNode;
}) {
  return (
    <section className="ptc ptc-stack" aria-label="Shared stack">
      {!count && <p className="pt-empty">Stack is empty</p>}
      {children}
    </section>
  );
}
