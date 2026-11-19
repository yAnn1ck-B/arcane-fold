import { useState, type ReactNode } from "react";
import { Eye, Library, Search, SquarePlus } from "lucide-react";
import { prepareShuffle, projectMatch } from "./engine";
import {
  CombatControls,
  ManualOpeningHand,
  PlayerControls,
  StackControls,
  TurnControls,
} from "./TableControls";
import { CardInspector, CardTile, pieceName } from "./TableCards";
import {
  seats,
  type Action,
  type Match,
  type MatchView,
  type Seat,
  type Zone,
} from "./types";
import {
  SwitchPlayer,
  TableBoard,
  TableSeat,
  TurnSummary,
  ZoneCounter,
  type MatchTools,
} from "./TableBoard";
import { TableDialog } from "./TableDialog";
import { battlefieldGroup } from "./battlefield";
import { GameIssueReporting } from "./GameIssueReporter";
import { captureManualIssue, type GameIssueReport } from "./issue-report";

type Dispatch = (action: Action) => void;
const pileZones = ["library", "hand", "graveyard", "exile", "command"] as const;
const zoneNames: Record<Zone, string> = {
  library: "Library",
  hand: "Hand",
  battlefield: "Battlefield",
  graveyard: "Graveyard",
  exile: "Exile",
  command: "Command",
};
type Pile = { seat: Seat; zone: (typeof pileZones)[number] };

export default function Table({
  match,
  submitReport,
  dispatch,
  matchTools,
  initialViewer,
  requiredOpening,
  reportContext,
}: {
  match: Match;
  submitReport: (report: GameIssueReport) => Promise<void>;
  dispatch: Dispatch;
  matchTools: MatchTools;
  initialViewer?: Seat;
  requiredOpening: boolean;
  reportContext: TableViewProps["reportContext"];
}) {
  const needsHand = (seat: Seat) => !match.players[seat].kept && match.players[seat].zones.hand.length > 0;
  const opening = requiredOpening && seats.some(needsHand);
  const [selection, setSelection] = useState({
    turn: match.turn,
    seat: opening ? match.active : match.handoffDecision?.seat ?? initialViewer ?? match.active,
  });
  const preferred = selection.turn === match.turn ? selection.seat : match.active;
  const first = initialViewer ?? preferred;
  const openingSeat = needsHand(first) ? first : first === 0 ? 1 : 0;
  const viewer = opening ? openingSeat : preferred;
  return (
    <TableView
      key={viewer}
      match={match}
      matchTools={matchTools}
      requiredOpening={requiredOpening}
      reportContext={reportContext}
      viewer={viewer}
      dispatch={dispatch}
      submitReport={submitReport}
      changeSeat={() => setSelection({ turn: match.turn, seat: viewer === 0 ? 1 : 0 })}
    />
  );
}

interface TableViewProps {
  reportContext: { id: string; revision: string | number; error?: string };
  matchTools: MatchTools;
  requiredOpening: boolean;
  match: Match;
  viewer: Seat;
  dispatch: Dispatch;
  submitReport: (report: GameIssueReport) => Promise<void>;
  changeSeat: () => void;
}

function TableView({ match, ...props }: TableViewProps) {
  const { viewer, dispatch } = props;
  const [looked, setLooked] = useState<ReadonlySet<string>>(new Set());
  const view = projectMatch(match, viewer, looked);
  function onLook(count: number) {
    setLooked(new Set(projectMatch(match, viewer, count).players[viewer].zones.library));
  }
  function onShuffle(seat: Seat, mulligan?: boolean) {
    setLooked(new Set());
    dispatch(prepareShuffle(match, seat, mulligan));
  }
  return <ProjectedTable {...props} view={view} onLook={onLook} onShuffle={onShuffle} />;
}

interface ProjectedTableProps extends Omit<TableViewProps, "match" | "changeSeat"> {
  view: MatchView;
  changeSeat?: () => void;
  onLook: (count: number) => void;
  looking?: boolean;
  onShuffle: (seat: Seat, mulligan?: boolean) => void;
  openingCanAct?: boolean;
  locked?: boolean;
}
export function ProjectedTable({ matchTools, requiredOpening, view, viewer, dispatch,
  changeSeat, reportContext, onLook, onShuffle, submitReport, openingCanAct = true, locked = false, looking = true,
}: ProjectedTableProps) {
  const [selected, select] = useState<string | null>(null);
  const [pile, setPile] = useState<Pile | null>(null);
  const [query, setQuery] = useState("");
  const [lookCount, setLookCount] = useState("3");
  const [lookMode, setLookMode] = useState<"none" | "top" | "all">("none");
  const [tokenName, setTokenName] = useState("");
  const [addingToken, setAddingToken] = useState(false);
  const other: Seat = viewer === 0 ? 1 : 0;
  const seatNames = [matchTools.seatNames.player, matchTools.seatNames.opponent] as const;
  const common = { view, viewer, dispatch, seatNames };
  const reviewingOpening =
    requiredOpening && view.players.some((p) => !p.kept && p.counts.hand > 0);
  const boardLocked = locked || (!changeSeat && reviewingOpening);
  const controls = (children: ReactNode) => changeSeat ? children :
    <fieldset className="pt-manual-controls" disabled={boardLocked}>{children}</fieldset>;
  function showPile(seat: Seat, zone: Pile["zone"]) {
    if (looking) onLook(0);
    setQuery("");
    setLookMode("none");
    setPile({ seat, zone });
  }
  function closePile(clearLook = true) {
    setPile(null);
    setLookMode("none");
    setQuery("");
    if (clearLook && looking) onLook(0);
  }
  const selectedPiece = selected ? view.pieces[selected] : null;
  const selectedSeat = selected
    ? seats.find((seat) =>
        Object.values(view.players[seat].zones).some((ids) =>
          ids.includes(selected),
        ),
      )
    : undefined;
  const selectedZone =
    selected && selectedSeat !== undefined
      ? (Object.keys(view.players[selectedSeat].zones) as Zone[]).find((zone) =>
          view.players[selectedSeat].zones[zone].includes(selected),
        )
      : undefined;
  const pileIds = pile ? view.players[pile.seat].zones[pile.zone] : [];
  const foundIds = query.trim()
    ? pileIds.filter((id) =>
        pieceName(view, id).toLowerCase().includes(query.trim().toLowerCase()),
      )
    : pileIds;
  const renderTile = (id: string, zone: Zone) => (
    <CardTile
      key={id}
      id={id}
      view={view}
      zone={zone}
      dispatch={dispatch}
      locked={boardLocked}
      onClick={() => select(id)}
    />
  );

  return (
    <GameIssueReporting submit={submitReport} capture={() => captureManualIssue(reportContext.id, reportContext.revision, view, matchTools.history, reportContext.error)}>
    <TableBoard
      label="Manual game"
      switchPlayer={changeSeat && <SwitchPlayer playerName={seatNames[other]} onSwitch={changeSeat} />}
      matchTools={matchTools}
      stackCount={view.stack.length}
      toolbar={<TurnSummary turn={view.turn} activeName={seatNames[view.active]} />}
      actions={
        <>
          <TurnControls {...common} locked={boardLocked || (!changeSeat && (viewer !== view.active || !!view.handoffDecision))} />
          {view.handoffDecision && (
            <details className="pt-pending-decision" open>
              <summary>Pending decision · {seatNames[view.handoffDecision.seat]}</summary>
              <p>{view.handoffDecision.text}</p>
              {view.handoffDecision.choices.length > 0 && (
                <ul>
                  {view.handoffDecision.choices.map((choice, i) => (
                    <li key={i}>{choice}</li>
                  ))}
                </ul>
              )}
              <button
                type="button"
                className="pt-btn"
                disabled={boardLocked}
                onClick={() =>
                  dispatch({ type: "finishDecision", seat: viewer })
                }
              >
                Mark resolved
              </button>
            </details>
          )}
        </>
      }
      seats={([other, viewer] as const).map((seat) => {
        const player = view.players[seat];
        return (
          <TableSeat
            key={seat}
            own={seat === viewer}
            playerName={seatNames[seat]}
            piles={pileZones
              .filter((zone) => zone !== "command" || player.counts.command > 0)
              .map((zone) => (
                <ZoneCounter
                  key={zone}
                  zone={zone}
                  count={player.counts[zone]}
                  open={pile?.seat === seat && pile.zone === zone}
                  onOpen={() => showPile(seat, zone)}
                  label={`${seatNames[seat]}'s ${zone}, ${player.counts[zone]} ${player.counts[zone] === 1 ? "card" : "cards"}`}
                />
              ))}
            resources={controls(
              <PlayerControls
                {...common}
                seat={seat}
                onShuffle={(target, mulligan) => {
                  closePile(false);
                  onShuffle(target, mulligan);
                }}
              />
            )}
            battlefieldAction={
              seat === viewer && (
                <button
                  type="button"
                  className="pt-tool"
                  aria-label="Create token"
                  disabled={boardLocked}
                  data-hint="Create token"
                  aria-expanded={addingToken}
                  onClick={() => setAddingToken((current) => !current)}
                >
                  <SquarePlus size={15} aria-hidden />
                </button>
              )
            }
            battlefieldForm={
              seat === viewer &&
              addingToken && (
                <form
                  className="pt-token-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const name = tokenName.trim();
                    if (!name) return;
                    dispatch({ type: "token", name, seat });
                    setTokenName("");
                    setAddingToken(false);
                  }}
                >
                  <input
                    aria-label="Token name"
                    autoFocus
                    maxLength={80}
                    placeholder="Token name, e.g. 1/1 Soldier"
                    value={tokenName}
                    onChange={(event) => setTokenName(event.target.value)}
                  />
                  <button className="pt-btn" disabled={boardLocked || !tokenName.trim()}>
                    Create
                  </button>
                </form>
              )
            }
            cards={player.zones.battlefield.map((id) => {
              const piece = view.pieces[id];
              return {
                group: battlefieldGroup({
                  typeLine: piece.printing ? view.catalog[piece.printing]?.typeLine : undefined,
                  back: piece.back,
                  faceDown: piece.faceDown,
                  power: piece.power,
                }),
                tile: renderTile(id, "battlefield"),
              };
            })}
          />
        );
      })}
      handLabel={`${seatNames[viewer]}'s hand`}
      handCount={view.players[viewer].counts.hand}
      hand={
        reviewingOpening && changeSeat
          ? [
              <span key="opening" className="pt-empty">
                Opening hands
              </span>,
            ]
          : view.players[viewer].zones.hand.map((id) => renderTile(id, "hand"))
      }
      stack={controls(<StackControls {...common} />)}
    >
      {openingCanAct && <ManualOpeningHand
        {...common}
        onShuffle={onShuffle}
        required={requiredOpening}
        allowTable={!changeSeat}
        locked={locked}
        error={matchTools.decisionError}
      />}
      {pile && (
        <TableDialog
          title={zoneNames[pile.zone]}
          label={`${seatNames[pile.seat]}'s ${pile.zone}`}
          subtitle={`${seatNames[pile.seat]} · ${view.players[pile.seat].counts[pile.zone]} cards`}
          closeLabel="Close zone"
          onClose={() => closePile()}
        >
          {pile.zone === "library" && pile.seat === viewer && (
            <div className="pt-library-tools">
              <button
                className="pt-btn"
                disabled={boardLocked}
                onClick={() => {
                  onLook(Infinity);
                  setLookMode("all");
                  setQuery("");
                }}
              >
                <Library size={15} /> Search library
              </button>
              <label>
                Look at top{" "}
                <input
                  type="number"
                  aria-label="Number of cards to look at"
                  min="1"
                  step="1"
                  value={lookCount}
                  onChange={(event) => setLookCount(event.target.value)}
                />
              </label>
              <button
                className="pt-btn"
                disabled={
                  boardLocked || !Number.isSafeInteger(Number(lookCount)) ||
                  Number(lookCount) < 1
                }
                onClick={() => {
                  onLook(Number(lookCount));
                  setLookMode("top");
                  setQuery("");
                }}
              >
                <Eye size={15} /> Look
              </button>
            </div>
          )}
          {pileIds.length > 0 && (
            <label className="pt-query">
              <Search size={15} />
              <input
                type="search"
                placeholder="Find a card"
                aria-label="Filter visible cards"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
          )}
          {(lookMode === "all" || lookMode === "top") && (
            <p className="pt-subtle">Library order, top first</p>
          )}
          {!!foundIds.length && (
            <div className="pt-field">
              {foundIds.map((id) => renderTile(id, pile.zone))}
            </div>
          )}
          {!foundIds.length && (
            <p className="pt-subtle">
              {pileIds.length
                ? "No matching cards."
                : !view.players[pile.seat].counts[pile.zone]
                  ? "This zone is empty."
                  : pile.zone === "library" &&
                      pile.seat === viewer &&
                      lookMode === "none"
                    ? "Look at the top cards or search your library."
                    : "No visible cards."}
            </p>
          )}
        </TableDialog>
      )}
      {selectedPiece && selectedZone && (
        <CardInspector
          key={selectedPiece.id}
          {...common}
          id={selectedPiece.id}
          zone={selectedZone}
          locked={boardLocked}
          close={() => select(null)}
        >
          {selectedZone === "battlefield" &&
            selectedPiece.controller === viewer && (
              <CombatControls {...common} cardId={selectedPiece.id} />
            )}
        </CardInspector>
      )}
    </TableBoard>
    </GameIssueReporting>
  );
}
