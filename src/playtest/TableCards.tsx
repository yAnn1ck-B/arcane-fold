import { useEffect, useRef, useState, type ReactNode, type Ref } from "react";
import {
  Circle,
  Eye,
  Layers,
  Link2,
  RotateCw,
  Sparkles,
  Swords,
  X,
} from "lucide-react";
import CardImage from "@/components/CardImage";
import type { Action, MatchView, Seat, Zone } from "./types";
import { seats } from "./types";

export function pieceName(view: MatchView, id: string) {
  const piece = view.pieces[id];
  return (
    piece?.tokenName ||
    (piece?.printing && view.catalog[piece.printing]?.name) ||
    "Face-down card"
  );
}

interface CardProps {
  id: string;
  view: MatchView;
  imageCacheDir: string;
}

function CardArt({
  id,
  view,
  imageCacheDir,
  inspect = false,
}: CardProps & { inspect?: boolean }) {
  const piece = view.pieces[id];
  const card = piece.printing ? view.catalog[piece.printing] : null;
  if (piece.faceDown && (!inspect || piece.controller !== view.viewer))
    return (
      <div className="pt-card-back">
        <Layers size={25} aria-hidden />
      </div>
    );
  if (card && (!piece.back || card.backImageUri))
    return (
      <CardImage
        card={card}
        imageCacheDir={imageCacheDir}
        face={piece.back ? "back" : "front"}
      />
    );
  return (
    <div className="pt-token-art">
      <Sparkles size={23} aria-hidden />
      <span>{piece.back ? "Back face" : piece.tokenName || "Face down"}</span>
    </div>
  );
}

export function TableCard({
  name,
  label,
  art,
  tapped,
  flags,
  quickAction,
  onClick,
  disabled,
  focusRef,
}: {
  name: string;
  label: string;
  art: ReactNode;
  tapped?: boolean;
  flags?: ReactNode;
  quickAction?: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  focusRef?: Ref<HTMLButtonElement>;
}) {
  return (
    <div className={`pt-piece ${tapped ? "is-tapped" : ""}`} title={label}>
      {art}
      <div className="pt-piece-flags" aria-hidden="true">
        {tapped && <RotateCw size={14} />}
        {flags}
      </div>
      {onClick ? (
        <button
          ref={focusRef}
          type="button"
          className="pt-piece-select"
          onClick={onClick}
          disabled={disabled}
          aria-label={label}
        >
          <span>{name}</span>
        </button>
      ) : (
        <span className="pt-piece-select" aria-label={label}>
          <span>{name}</span>
        </span>
      )}
      {quickAction}
    </div>
  );
}

export function CardTile(
  props: CardProps & {
    onClick: () => void;
    zone: Zone;
    dispatch: (action: Action) => void;
  },
) {
  const { id, view, onClick, zone, dispatch } = props;
  const piece = view.pieces[id];
  const name = piece.faceDown ? "Face-down card" : pieceName(view, id);
  const stateLabels = [
    piece.tapped && "Tapped",
    piece.back && !piece.faceDown && "Back face",
    piece.combat && (piece.combat === "attacking" ? "Attacking" : "Blocking"),
    piece.attachedTo && "Attached",
    piece.revealed && "Revealed",
    ...Object.entries(piece.counters).map(
      ([label, count]) => `${count} ${label}`,
    ),
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <TableCard
      name={name}
      label={stateLabels ? `${name}, ${stateLabels}` : name}
      art={<CardArt {...props} />}
      onClick={onClick}
      tapped={piece.tapped}
      flags={
        <>
          {piece.combat && <Swords size={14} />}
          {piece.attachedTo && <Link2 size={14} />}
          {piece.revealed && <Eye size={14} />}
          {Object.values(piece.counters).length > 0 && (
            <span>
              ◆ {Object.values(piece.counters).reduce((a, b) => a + b, 0)}
            </span>
          )}
        </>
      }
      quickAction={
        piece.controller === view.viewer &&
        zone === "battlefield" && (
          <button
            type="button"
            className="pt-quick"
            onClick={() => dispatch({ type: "tap", id })}
            aria-label={`${piece.tapped ? "Untap" : "Tap"} ${name}`}
          >
            {piece.tapped ? "Untap" : "Tap"}
          </button>
        )
      }
    />
  );
}

type InspectorProps = CardProps & {
  viewer: Seat;
  dispatch: (action: Action) => void;
  zone: Zone;
  close: () => void;
  children: ReactNode;
};

export function CardInspector({
  view,
  viewer,
  id,
  imageCacheDir,
  zone,
  dispatch,
  close,
  children,
}: InspectorProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [counterName, setCounterName] = useState("+1/+1");
  const [ability, setAbility] = useState("");
  const piece = view.pieces[id];
  const catalog = piece.printing ? view.catalog[piece.printing] : null;
  const canAct =
    (zone === "battlefield" ? piece.controller : piece.owner) === viewer;
  const battlefield = seats.flatMap(
    (seat) => view.players[seat].zones.battlefield,
  );
  const attached = battlefield.filter(
    (target) => view.pieces[target].attachedTo === id,
  );
  useEffect(() => {
    const current = dialog.current;
    current?.showModal();
    return () => current?.close();
  }, []);
  function move(destination: Zone, position?: "top" | "bottom") {
    dispatch({ type: "move", id, zone: destination, position });
    close();
  }
  function labelFor(target: string) {
    const item = view.pieces[target];
    const seat = item.controller;
    return `${item.faceDown ? "Face-down card" : pieceName(view, target)} · P${seat + 1} #${view.players[seat].zones.battlefield.indexOf(target) + 1}`;
  }
  return (
    <dialog
      ref={dialog}
      className="pt-card-dialog"
      aria-labelledby="pt-inspect-title"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onClick={(event) => {
        if (event.target === dialog.current) {
          const rect = dialog.current.getBoundingClientRect();
          if (
            event.clientX < rect.left ||
            event.clientX >= rect.right ||
            event.clientY < rect.top ||
            event.clientY >= rect.bottom
          )
            close();
        }
      }}
    >
      <header className="pt-pile-heading">
        <div>
          <small>
            Player {piece.controller + 1} · {zone}
          </small>
          <h2 id="pt-inspect-title">{pieceName(view, id)}</h2>
        </div>
        <button
          type="button"
          className="pt-btn"
          autoFocus
          onClick={close}
          aria-label="Close card"
        >
          <X size={17} />
        </button>
      </header>
      <div className="pt-inspect-content">
        <div className="pt-inspect-art">
          <CardArt view={view} id={id} imageCacheDir={imageCacheDir} inspect />
          {catalog?.manaCost && <b>{catalog.manaCost}</b>}
          {catalog?.typeLine && <small>{catalog.typeLine}</small>}
          {catalog?.oracleText && <p>{catalog.oracleText}</p>}
        </div>
        <div className="pt-inspect-tools">
          {piece.controller !== piece.owner && (
            <p>Owned by Player {piece.owner + 1}</p>
          )}
          {piece.faceDown && <p>Face down</p>}
          {piece.tapped && <p>Tapped</p>}
          {piece.combat && (
            <p>{piece.combat === "attacking" ? "Attacking" : "Blocking"}</p>
          )}
          {piece.revealed && <p>Revealed to both players</p>}
          {piece.attachedTo && view.pieces[piece.attachedTo] && (
            <p>Attached to {labelFor(piece.attachedTo)}</p>
          )}
          {attached.length > 0 && (
            <p>Attachments: {attached.map(labelFor).join(", ")}</p>
          )}
          {Object.keys(piece.counters).length > 0 && (
            <p>
              {Object.entries(piece.counters)
                .map(([label, count]) => `${label} × ${count}`)
                .join(" · ")}
            </p>
          )}
          {canAct && (
            <>
              <fieldset>
                <legend>Move card</legend>
                <div className="pt-action-grid">
                  {zone !== "battlefield" && (
                    <button
                      className="pt-btn"
                      onClick={() => move("battlefield")}
                    >
                      To battlefield
                    </button>
                  )}
                  {zone !== "hand" && (
                    <button className="pt-btn" onClick={() => move("hand")}>
                      To hand
                    </button>
                  )}
                  {zone !== "graveyard" && (
                    <button
                      className="pt-btn"
                      onClick={() => move("graveyard")}
                    >
                      To graveyard
                    </button>
                  )}
                  {zone !== "exile" && (
                    <button className="pt-btn" onClick={() => move("exile")}>
                      To exile
                    </button>
                  )}
                  <button
                    className="pt-btn"
                    onClick={() => move("library", "top")}
                  >
                    Library top
                  </button>
                  <button
                    className="pt-btn"
                    onClick={() => move("library", "bottom")}
                  >
                    Library bottom
                  </button>
                  {!piece.tokenName && (
                    <button
                      className="pt-btn pt-primary"
                      onClick={() => {
                        dispatch({ type: "cast", id });
                        close();
                      }}
                    >
                      Cast on stack
                    </button>
                  )}
                </div>
              </fieldset>
              {(zone === "hand" || zone === "library") && (
                <button
                  className="pt-btn"
                  onClick={() => dispatch({ type: "reveal", id })}
                >
                  <Eye size={14} />
                  {piece.revealed ? "Hide card" : "Reveal to opponent"}
                </button>
              )}
              <fieldset>
                <legend>Card face</legend>
                <div className="pt-action-grid">
                  <button
                    className="pt-btn"
                    onClick={() => dispatch({ type: "flip", id })}
                  >
                    {piece.back ? "Show front face" : "Flip to back"}
                  </button>
                  <button
                    className="pt-btn"
                    onClick={() => dispatch({ type: "faceDown", id })}
                  >
                    {piece.faceDown ? "Turn face up" : "Turn face down"}
                  </button>
                </div>
              </fieldset>
              {zone === "battlefield" && (
                <>
                  <fieldset>
                    <legend>Permanent</legend>
                    <div className="pt-action-grid">
                      <button
                        className="pt-btn"
                        onClick={() => dispatch({ type: "tap", id })}
                      >
                        {piece.tapped ? "Untap" : "Tap"}
                      </button>
                      <button
                        className="pt-btn"
                        onClick={() => {
                          dispatch({ type: "control", id });
                          close();
                        }}
                      >
                        Give control to P{(viewer === 0 ? 1 : 0) + 1}
                      </button>
                    </div>
                  </fieldset>
                  <form
                    className="pt-counter-edit"
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (!ability.trim()) return;
                      dispatch({ type: "ability", id, label: ability.trim() });
                      close();
                    }}
                  >
                    <input
                      aria-label="Ability description"
                      placeholder="Ability description"
                      maxLength={200}
                      value={ability}
                      onChange={(e) => setAbility(e.target.value)}
                    />
                    <button className="pt-btn" disabled={!ability.trim()}>
                      Add to stack
                    </button>
                  </form>
                  <fieldset>
                    <legend>Counters</legend>
                    <div className="pt-counter-edit">
                      <input
                        aria-label="Counter name"
                        value={counterName}
                        maxLength={60}
                        placeholder="Counter name"
                        onChange={(event) => setCounterName(event.target.value)}
                      />
                      <button
                        className="pt-btn"
                        aria-label="Remove counter"
                        disabled={!piece.counters[counterName.trim()]}
                        onClick={() =>
                          dispatch({
                            type: "counter",
                            id,
                            name: counterName.trim(),
                            delta: -1,
                          })
                        }
                      >
                        −
                      </button>
                      <button
                        className="pt-btn"
                        aria-label="Add counter"
                        disabled={!counterName.trim()}
                        onClick={() =>
                          dispatch({
                            type: "counter",
                            id,
                            name: counterName.trim(),
                            delta: 1,
                          })
                        }
                      >
                        +
                      </button>
                    </div>
                  </fieldset>
                  <label className="pt-attach-label">
                    Attach to
                    <select
                      value={piece.attachedTo ?? ""}
                      onChange={(event) =>
                        dispatch({
                          type: "attach",
                          id,
                          to: event.target.value || null,
                        })
                      }
                    >
                      <option value="">Unattached</option>
                      {battlefield
                        .filter((other) => other !== id)
                        .map((other) => (
                          <option key={other} value={other}>
                            {labelFor(other)}
                          </option>
                        ))}
                    </select>
                  </label>
                  {children}
                </>
              )}
            </>
          )}
          {!canAct && (
            <p className="pt-subtle">
              <Circle size={10} /> Switch seats to control this card.
            </p>
          )}
        </div>
      </div>
    </dialog>
  );
}
