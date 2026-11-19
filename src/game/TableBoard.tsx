import {
  ArrowLeftRight,
  Crown,
  Hand,
  Heart,
  Layers,
  Ellipsis,
  DoorOpen,
  Orbit,
  PanelRightClose,
  ScrollText,
  SlidersHorizontal,
  Skull,
  SquareStack,
} from "lucide-react";
import {
  useId,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react";
import { GameIssueButton } from "./GameIssueButton";
import { PriorityStopsDialog, type PriorityStopSettings } from "./PriorityStopsDialog";
import type { BattlefieldGroup } from "./battlefield";
import type { HistoryEntry } from "./types";
import type { ForgeSeat } from "./forge-match";
import "./table.css";
import "./controls.css";

export interface MatchTools {
  seatNames: Record<ForgeSeat, string>;
  history: HistoryEntry[];
  onLeave: () => void;
  leaveLabel: string;
  leaveDisabled?: boolean;
  actionStatus?: ReactNode;
  historyLog: ReactNode;
  manualSwitch?: ReactNode;
  concede?: ReactNode;
  decisionError?: ReactNode;
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
  className,
}: {
  zone: keyof typeof zoneIcons;
  count: number;
  label: string;
  onOpen?: () => void;
  open?: boolean;
  className?: string;
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
      className={className ? `pt-zone-chip ${className}` : "pt-zone-chip"}
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
      className={className ? `pt-zone-chip ${className}` : "pt-zone-chip"}
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
  playerName,
  onSwitch,
  disabled,
  focusRef,
}: {
  playerName: string;
  onSwitch: () => void;
  disabled?: boolean;
  focusRef?: Ref<HTMLButtonElement>;
}) {
  return (
    <button
      type="button"
      className="pt-tool"
      onClick={onSwitch}
      disabled={disabled}
      ref={focusRef}
      aria-label={`Switch to ${playerName}`}
      data-hint={`Switch to ${playerName}`}
    >
      <ArrowLeftRight size={16} aria-hidden />
    </button>
  );
}

function TableOptions({ matchTools, priorityControl }: { matchTools: MatchTools; priorityControl?: PriorityStopSettings }) {
  const [open, setOpen] = useState(false);
  const [showPriority, setShowPriority] = useState(false);
  const toolbar = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const optionsId = useId();
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!toolbar.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  return <div className="pt-options" ref={toolbar}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}
    onKeyDown={event => {
      if (event.key === "Escape" && open) {
        event.preventDefault();
        setOpen(false);
        trigger.current?.focus();
      }
    }}>
    <button type="button" className="pt-tool" aria-label="More game options" data-hint="More game options"
      ref={trigger} aria-expanded={open} aria-controls={optionsId} onClick={() => setOpen(value => !value)}>
      <Ellipsis size={18} aria-hidden />
    </button>
    {open && <div id={optionsId} className="pt-options-list" role="group" aria-label="Game options"
      onClick={event => {
        if ((event.target as Element).closest("button")) {
          setOpen(false);
          trigger.current?.focus();
        }
      }}>
      {priorityControl && <button type="button" className="pt-tool" disabled={priorityControl.locked}
        aria-haspopup="dialog" onClick={() => setShowPriority(true)}>
        <SlidersHorizontal size={16} aria-hidden />Priority stops
        <small className="pt-stop-mode">{priorityControl.stops.own.length || priorityControl.stops.opponent.length ? "Manual" : "Automatic"}</small>
      </button>}
      {matchTools.manualSwitch}
      {matchTools.concede}
      <GameIssueButton showLabel />
      <button type="button" className="pt-tool" disabled={matchTools.leaveDisabled} onClick={matchTools.onLeave}>
        <DoorOpen size={16} aria-hidden />{matchTools.leaveLabel}
      </button>
    </div>}
    {showPriority && priorityControl && <PriorityStopsDialog {...priorityControl} onClose={() => setShowPriority(false)} />}
  </div>;
}

export function TableBoard({
  label,
  toolbar,
  actions,
  priorityControl,
  switchPlayer,
  seats,
  arenaOverlay,
  handCount,
  handLabel = "Your hand",
  hand,
  stack,
  stackCount,
  stackTargets,
  matchTools,
  children,
}: {
  label: string;
  toolbar: ReactNode;
  actions: ReactNode;
  priorityControl?: PriorityStopSettings;
  switchPlayer?: ReactNode;
  seats: ReactNode;
  arenaOverlay?: ReactNode;
  handCount: number;
  handLabel?: string;
  hand: ReactNode[];
  stack: ReactNode;
  stackCount: number;
  stackTargets?: boolean;
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
      {matchTools.actionStatus}
      <div className="pt-turnbar">
        {toolbar}
        <div className="pt-table-tools" role="group" aria-label="Game tools">
          <button
            type="button"
            className={stackTargets ? "pt-tool pt-legal-target" : "pt-tool"}
            ref={stackTrigger}
            aria-label={`Stack, ${stackCount} ${stackCount === 1 ? "entry" : "entries"}${stackTargets ? ", contains a legal target" : ""}`}
            data-hint={stackTargets ? "Stack · Contains a legal target" : "Stack"}
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
          {switchPlayer}
          <TableOptions matchTools={matchTools} priorityControl={priorityControl} />
        </div>
        {actions}
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
          {arenaOverlay}
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
          {panel === "log" && matchTools.historyLog}
        </aside>
      </div>
      {children}
    </section>
  );
}

export function TurnSummary({ turn, activeName }: { turn: number; activeName: string }) {
  if (turn < 1) return null;
  return <p className="pt-turn-summary">Turn {turn} <span aria-hidden>·</span> {activeName}’s turn</p>;
}

export function TableSeat({
  own,
  playerName,
  piles,
  resources,
  battlefieldAction,
  battlefieldForm,
  cards,
}: {
  own: boolean;
  playerName: string;
  piles?: ReactNode;
  resources: ReactNode;
  battlefieldAction?: ReactNode;
  battlefieldForm?: ReactNode;
  cards: { group: BattlefieldGroup; tile: ReactNode }[];
}) {
  const rows: Record<BattlefieldGroup, ReactNode[]> = {
    Creatures: [],
    Lands: [],
    "Other permanents": [],
  };
  for (const { group, tile } of cards) rows[group].push(tile);
  const frontToBack: BattlefieldGroup[] = own ? ["Creatures", "Lands"] : ["Lands", "Creatures"];
  function row(group: BattlefieldGroup) {
    return rows[group].length > 0 && (
      <div key={group} className="pt-permanent-row" data-type={group} role="group" aria-label={group}>
        {rows[group]}
      </div>
    );
  }
  const seatTools = (
    <>
      <header className="pt-seat-heading">
        <h2 className="pt-seat-title">
          {playerName}
        </h2>
        {resources}
        {piles && (
          <div
            className="pt-piles"
            role="group"
            aria-label={`${playerName}'s zones`}
          >
            {piles}
          </div>
        )}
        {battlefieldAction}
      </header>
      {battlefieldForm}
    </>
  );
  return (
    <section
      className={`pt-seat ${own ? "pt-own" : "pt-opponent"}`}
      aria-label={`${playerName}'s battlefield`}
    >
      {!own && seatTools}
      {cards.length ? (
        <div className="pt-battlefield">
          <div className="pt-main-permanents">{frontToBack.map(row)}</div>
          {row("Other permanents")}
        </div>
      ) : (
        <div className="pt-field"><span className="pt-empty">Empty battlefield</span></div>
      )}
      {own && seatTools}
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
