import { useRef, useState } from "react";
import { ArrowLeftRight, Eye, Library, Search, X } from "lucide-react";
import type { AppSettings } from "@/lib/types";
import { prepareShuffle, projectMatch } from "./engine";
import {
  CombatControls,
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
import { TableBoard, TableSeat } from "./TableBoard";

type Dispatch = (action: Action) => void;
const pileZones = ["library", "hand", "graveyard", "exile"] as const;
const zoneNames: Record<Zone, string> = {
  library: "Library",
  hand: "Hand",
  battlefield: "Battlefield",
  graveyard: "Graveyard",
  exile: "Exile",
};
type Pile = { seat: Seat; zone: (typeof pileZones)[number] };

export default function Table({
  match,
  settings,
  dispatch,
}: {
  match: Match;
  settings: AppSettings;
  dispatch: Dispatch;
}) {
  const [viewer, setViewer] = useState<Seat>(match.active);
  const [looked, setLooked] = useState<ReadonlySet<string>>(new Set());
  const view = projectMatch(match, viewer, looked);
  const changeSeat = () => {
    setViewer(viewer === 0 ? 1 : 0);
    setLooked(new Set());
  };
  return (
    <TableView
      key={viewer}
      view={view}
      viewer={viewer}
      dispatch={dispatch}
      imageCacheDir={settings.forge.imageCacheDir}
      changeSeat={changeSeat}
      onLook={(count) =>
        setLooked(
          new Set(
            projectMatch(match, viewer, count).players[viewer].zones.library,
          ),
        )
      }
      onShuffle={(seat, mulligan) => {
        setLooked(new Set());
        dispatch(prepareShuffle(match, seat, mulligan));
      }}
    />
  );
}

interface TableViewProps {
  view: MatchView;
  viewer: Seat;
  dispatch: Dispatch;
  imageCacheDir: string;
  changeSeat: () => void;
  onLook: (count: number) => void;
  onShuffle: (seat: Seat, mulligan?: boolean) => void;
}

function TableView({
  view,
  viewer,
  dispatch,
  imageCacheDir,
  changeSeat,
  onLook,
  onShuffle,
}: TableViewProps) {
  const [selected, select] = useState<string | null>(null);
  const [pile, setPile] = useState<Pile | null>(null);
  const [query, setQuery] = useState("");
  const [lookCount, setLookCount] = useState("3");
  const [lookMode, setLookMode] = useState<"none" | "top" | "all">("none");
  const [tokenName, setTokenName] = useState("");
  const [addingToken, setAddingToken] = useState(false);
  const pilePanel = useRef<HTMLElement>(null);
  const other: Seat = viewer === 0 ? 1 : 0;
  const common = { view, viewer, dispatch };
  function showPile(seat: Seat, zone: Pile["zone"]) {
    onLook(0);
    setQuery("");
    setLookMode("none");
    setPile({ seat, zone });
    requestAnimationFrame(() => pilePanel.current?.focus());
  }
  function closePile() {
    setPile(null);
    setLookMode("none");
    setQuery("");
    onLook(0);
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
      imageCacheDir={imageCacheDir}
      onClick={() => select(id)}
    />
  );

  return (
    <TableBoard
      label="Manual playtest table"
      toolbar={
        <>
          <TurnControls {...common} />
          <button type="button" className="pt-seat-switch" onClick={changeSeat}>
            <ArrowLeftRight size={16} /> Switch to Player {other + 1}
          </button>
        </>
      }
      seats={([other, viewer] as const).map((seat) => {
        const player = view.players[seat];
        return (
          <TableSeat
            key={seat}
            own={seat === viewer}
            label={`Player ${seat + 1}`}
            title={player.deckName}
            piles={pileZones.map((zone) => (
              <button
                type="button"
                key={zone}
                onClick={() => showPile(seat, zone)}
                aria-label={`Player ${seat + 1} ${zone}, ${player.counts[zone]} cards`}
              >
                {zoneNames[zone]} <b>{player.counts[zone]}</b>
              </button>
            ))}
            resources={
              <PlayerControls
                {...common}
                seat={seat}
                onShuffle={(target, mulligan) => {
                  closePile();
                  onShuffle(target, mulligan);
                }}
              />
            }
            battlefieldAction={
              seat === viewer && (
                <button
                  type="button"
                  className="pt-link"
                  aria-expanded={addingToken}
                  onClick={() => setAddingToken((current) => !current)}
                >
                  Create token
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
                  <button className="pt-btn" disabled={!tokenName.trim()}>
                    Create
                  </button>
                </form>
              )
            }
            cards={player.zones.battlefield.map((id) =>
              renderTile(id, "battlefield"),
            )}
          />
        );
      })}
      handCount={view.players[viewer].counts.hand}
      hand={view.players[viewer].zones.hand.map((id) => renderTile(id, "hand"))}
      stack={<StackControls {...common} />}
    >
      {pile && (
        <section
          className="pt-pile-panel"
          ref={pilePanel}
          tabIndex={-1}
          aria-label={`Player ${pile.seat + 1} ${pile.zone}`}
        >
          <header className="pt-pile-heading">
            <div>
              <small>Player {pile.seat + 1}</small>
              <h3>
                {zoneNames[pile.zone]}{" "}
                <small>{view.players[pile.seat].counts[pile.zone]}</small>
              </h3>
            </div>
            <button
              onClick={closePile}
              className="pt-btn"
              aria-label="Close zone"
            >
              <X size={16} />
            </button>
          </header>
          {pile.zone === "library" && pile.seat === viewer && (
            <div className="pt-library-tools">
              <button
                className="pt-btn"
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
                  !Number.isSafeInteger(Number(lookCount)) ||
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
          <div className="pt-pile-list">
            {foundIds.map((id) => (
              <button type="button" key={id} onClick={() => select(id)}>
                {pieceName(view, id)}
                {view.pieces[id].revealed && (
                  <Eye size={14} aria-label="Revealed" />
                )}
              </button>
            ))}
          </div>
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
        </section>
      )}
      {selectedPiece && selectedZone && (
        <CardInspector
          key={selectedPiece.id}
          {...common}
          id={selectedPiece.id}
          zone={selectedZone}
          imageCacheDir={imageCacheDir}
          close={() => select(null)}
        >
          {selectedZone === "battlefield" &&
            selectedPiece.controller === viewer && (
              <CombatControls {...common} cardId={selectedPiece.id} />
            )}
        </CardInspector>
      )}
    </TableBoard>
  );
}
