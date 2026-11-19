import { useId, useState, type ReactNode } from "react";
import { defaultDestination } from "./engine";
import {
  ArrowDown,
  ArrowUp,
  ChevronRight,
  ChevronsRight,
  Copy,
  Minus,
  Plus,
  Shield,
  Shuffle,
  Swords,
} from "lucide-react";
import {
  manaTypes,
  steps,
  turnPhases,
  type Action,
  type MatchView,
  type Seat,
  type StackEntry,
  type Zone,
} from "./types";
import { LifeValue, StackPanel } from "./TableBoard";
import CardImage from "@/components/CardImage";
import { CardReading, StackCardName } from "./CardPreview";
import { CardArt, TableCard } from "./TableCards";
import { OpeningHandDialog } from "./OpeningHandDialog";
import { ManaPool } from "./ManaPool";

interface ControlProps {
  view: MatchView;
  viewer: Seat;
  dispatch: (action: Action) => void;
}

function cardName(view: MatchView, id: string) {
  const card = view.pieces[id];
  if (!card || card.faceDown) return "Face-down card";
  return card.tokenName ?? view.catalog[card.printing ?? ""]?.name ?? "Card";
}

export function TurnControls({ view, dispatch, locked = false }: ControlProps & { locked?: boolean }) {
  return (
    <section className="ptc ptc-turn" aria-label="Turn, phase and step">
      <div className="ptc-turn-number">
        Turn <strong>{view.turn}</strong>
      </div>
      <span
        className="ptc-turn-player"
        aria-label={`Player ${view.active + 1}'s turn`}
      >
        P{view.active + 1}
      </span>
      <select
        aria-label="Current phase or step"
        disabled={locked}
        value={view.step}
        onChange={(e) =>
          dispatch({ type: "setStep", step: Number(e.target.value) })
        }
      >
        {turnPhases.map((phase) =>
          phase.steps.length ? (
            <optgroup label={phase.name} key={phase.name}>
              {phase.steps.map((step) => (
                <option key={step} value={steps.indexOf(step)}>
                  {step === steps[7] && view.firstStrikeDamage
                    ? "First-strike combat damage"
                    : step}
                </option>
              ))}
            </optgroup>
          ) : (
            <option key={phase.name} value={steps.indexOf(phase.name)}>
              {phase.name}
            </option>
          ),
        )}
      </select>
      <button type="button" disabled={locked} onClick={() => dispatch({ type: "nextStep" })}>
        Next step <ChevronRight size={14} />
      </button>
      <button type="button" disabled={locked} onClick={() => dispatch({ type: "nextTurn" })}>
        Next turn <ChevronsRight size={14} />
      </button>
    </section>
  );
}

export function ManualOpeningHand({
  view,
  viewer,
  dispatch,
  onShuffle,
  imageCacheDir,
  required,
  allowTable,
  tools,
  locked = false,
  error,
}: ControlProps & {
  onShuffle: PlayerOptions["onShuffle"];
  imageCacheDir: string;
  required: boolean;
  allowTable?: boolean;
  tools?: ReactNode;
  locked?: boolean;
  error?: ReactNode;
}) {
  const seat = viewer;
  const player = view.players[seat];
  const [selection, setSelection] = useState<string[]>(
    player.openingBottom ?? [],
  );
  const hand = player.zones.hand;
  const needed = player.mulligans;
  const bottom = selection.filter((id) => hand.includes(id));
  if (player.kept || !hand.length) return null;
  return (
    <OpeningHandDialog
      player={seat + 1}
      required={required}
      allowTable={allowTable}
      tools={tools}
      error={error}
      prompt={
        needed > 0
          ? `Choose ${needed} ${needed === 1 ? "card" : "cards"} to put on the bottom, in order (${bottom.length}/${needed}).`
          : undefined
      }
      hand={hand.map((id, index) => {
        const piece = view.pieces[id];
        const name = cardName(view, id);
        const catalog =
          !piece.faceDown && piece.printing
            ? view.catalog[piece.printing]
            : undefined;
        const art = (
          <CardArt view={view} id={id} imageCacheDir={imageCacheDir} />
        );
        const order = bottom.indexOf(id);
        return (
          <TableCard
            key={id}
            name={name}
            label={`Hand card ${index + 1}: ${name}`}
            art={art}
            reading={
              <CardReading
                name={name}
                art={art}
                manaCost={catalog?.manaCost}
                typeLine={catalog?.typeLine}
                oracleText={catalog?.oracleText}
              />
            }
            flags={order >= 0 && <span>Bottom {order + 1}</span>}
            pressed={needed ? order >= 0 : undefined}
            disabled={order < 0 && bottom.length >= needed}
            onClick={
              needed
                ? () =>
                    setSelection(
                      order >= 0
                        ? bottom.filter((otherId) => otherId !== id)
                        : [...bottom, id],
                    )
                : undefined
            }
          />
        );
      })}
      actions={
        <>
          <button
            type="button"
            className="pt-btn"
            onClick={() => {
              setSelection([]);
              onShuffle(seat, true);
            }}
            disabled={
              locked || !hand.length || player.mulligans >= Math.min(7, hand.length)
            }
          >
            <Shuffle size={15} aria-hidden /> Mulligan
          </button>
          <button
            type="button"
            className="pt-btn pt-primary"
            disabled={locked || bottom.length !== needed}
            onClick={() => {
              dispatch({ type: "keep", seat, bottom });
              setSelection([]);
            }}
          >
            Keep {Math.max(0, hand.length - needed)}
          </button>
        </>
      }
    />
  );
}

interface PlayerOptions {
  seat: Seat;
  onShuffle: (seat: Seat, mulligan?: boolean) => void;
}

export function PlayerControls(props: ControlProps & PlayerOptions) {
  const { view, seat, viewer, dispatch, onShuffle } = props;
  const player = view.players[seat];
  const own = seat === viewer;
  const totalMana = manaTypes.reduce((sum, type) => sum + player.mana[type], 0);
  return (
    <section
      className="ptc ptc-player"
      aria-label={`Player ${seat + 1} resources`}
    >
      <div className="ptc-row">
        <div className="ptc-life">
          {own && (
            <button
              type="button"
              aria-label="Lose one life"
              data-hint="Lose one life"
              onClick={() => dispatch({ type: "life", seat, delta: -1 })}
            >
              <Minus size={13} />
            </button>
          )}
          <LifeValue life={player.life} />
          {own && (
            <button
              type="button"
              aria-label="Gain one life"
              data-hint="Gain one life"
              onClick={() => dispatch({ type: "life", seat, delta: 1 })}
            >
              <Plus size={13} />
            </button>
          )}
        </div>
        {Object.entries(player.counters ?? {}).map(([name, count]) => (
          <span key={name} className="ptc-player-counter">
            {own && (
              <button
                type="button"
                aria-label={`Remove one ${name} counter from Player ${seat + 1}`}
                onClick={() =>
                  dispatch({ type: "playerCounter", seat, name, delta: -1 })
                }
              >
                <Minus size={12} />
              </button>
            )}
            {name} <b>{count}</b>
            {own && (
              <button
                type="button"
                aria-label={`Add one ${name} counter to Player ${seat + 1}`}
                onClick={() =>
                  dispatch({ type: "playerCounter", seat, name, delta: 1 })
                }
              >
                <Plus size={12} />
              </button>
            )}
          </span>
        ))}
        {own && (
          <>
            <button
              type="button"
              disabled={!player.counts.library}
              onClick={() => dispatch({ type: "draw", seat })}
            >
              Draw card
            </button>
            <button
              type="button"
              aria-label="Shuffle library"
              data-hint="Shuffle library"
              disabled={player.counts.library < 2}
              onClick={() => onShuffle(seat)}
            >
              <Shuffle size={15} aria-hidden />
            </button>
            <button
              type="button"
              disabled={
                !player.zones.battlefield.some((id) => view.pieces[id]?.tapped)
              }
              onClick={() => dispatch({ type: "untapAll", seat })}
            >
              Untap all
            </button>
          </>
        )}
      </div>
      <ManaPool
        player={seat + 1}
        amounts={player.mana}
        total={totalMana}
        onChange={own ? (mana, delta) => dispatch({ type: "mana", seat, mana, delta }) : undefined}
        onClear={own ? () => dispatch({ type: "clearMana", seat }) : undefined}
      />
    </section>
  );
}

export function CombatControls({
  view,
  dispatch,
  cardId,
}: ControlProps & { cardId: string }) {
  const card = view.pieces[cardId];
  if (!card) return null;
  return (
    <div className="ptc ptc-row" role="group" aria-label="Combat markers">
      <button
        type="button"
        aria-pressed={card.combat === "attacking"}
        onClick={() =>
          dispatch({
            type: "combat",
            id: cardId,
            mark: card.combat === "attacking" ? null : "attacking",
          })
        }
      >
        <Swords size={14} /> Attacking
      </button>
      <button
        type="button"
        aria-pressed={card.combat === "blocking"}
        onClick={() =>
          dispatch({
            type: "combat",
            id: cardId,
            mark: card.combat === "blocking" ? null : "blocking",
          })
        }
      >
        <Shield size={14} /> Blocking
      </button>
    </div>
  );
}

function sourceOptions(view: MatchView, viewer: Seat) {
  const zones: Zone[] = ["hand", "battlefield", "graveyard", "exile"];
  return zones.flatMap((zone) =>
    view.players[viewer].zones[zone].map((id, i) => ({
      id,
      label: `${cardName(view, id)} · ${zone} ${i + 1}`,
    })),
  );
}

function targetSuggestions(view: MatchView) {
  return [
    ...view.players.flatMap((player, i) => [
      `Player ${i + 1}`,
      ...player.zones.battlefield.map(
        (id, j) => `${cardName(view, id)} (P${i + 1}, battlefield ${j + 1})`,
      ),
    ]),
    ...view.stack.map(
      (entry, i) => `${entry.label} (stack ${view.stack.length - i})`,
    ),
  ];
}

function StackComposer({
  view,
  dispatch,
  viewer,
  targetList,
}: ControlProps & { targetList: string }) {
  const [kind, setKind] = useState<"cast" | "ability">("cast");
  const [chosen, setChosen] = useState("");
  const [label, setLabel] = useState("");
  const [targets, setTargets] = useState("");
  const options = sourceOptions(view, viewer);
  const id = options.find((x) => x.id === chosen)?.id ?? options[0]?.id ?? "";
  return (
    <details className="ptc-compose">
      <summary>
        <Plus size={14} /> Add to stack
      </summary>
      <form
        className="ptc-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!id) return;
          if (kind === "cast")
            dispatch({ type: "cast", id, targets: targets.trim() });
          else if (label.trim())
            dispatch({
              type: "ability",
              id,
              label: label.trim(),
              targets: targets.trim(),
            });
          setLabel("");
          setTargets("");
        }}
      >
        <label>
          Entry
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as typeof kind)}
          >
            <option value="cast">Spell</option>
            <option value="ability">Ability</option>
          </select>
        </label>
        <label>
          Source card
          <select
            value={id}
            onChange={(e) => setChosen(e.target.value)}
            disabled={!options.length}
          >
            {!options.length && <option value="">No cards available</option>}
            {options.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        {kind === "ability" && (
          <label>
            Ability
            <input
              required
              maxLength={160}
              value={label}
              placeholder="Ability name or text"
              onChange={(e) => setLabel(e.target.value)}
            />
          </label>
        )}
        <label>
          Targets (optional)
          <input
            list={targetList}
            maxLength={240}
            value={targets}
            onChange={(e) => setTargets(e.target.value)}
          />
        </label>
        <button
          type="submit"
          className="ptc-accent"
          disabled={!id || (kind === "ability" && !label.trim())}
        >
          {kind === "cast" ? "Cast spell" : "Add ability"}
        </button>
      </form>
    </details>
  );
}

function StackItem({
  view,
  viewer,
  dispatch,
  entry,
  top,
  targetList,
  imageCacheDir,
}: ControlProps & {
  entry: StackEntry;
  top: boolean;
  targetList: string;
  imageCacheDir: string;
}) {
  const [editing, setEditing] = useState(false);
  const [targetDraft, setTargetDraft] = useState("");
  const [destination, setDestination] = useState<Zone | "">("");
  const cardId = entry.card ?? entry.source;
  const piece = cardId ? view.pieces[cardId] : undefined;
  const printing = entry.copyPrinting ?? piece?.printing;
  const card =
    printing && !piece?.faceDown && !entry.copyFaceDown
      ? view.catalog[printing]
      : null;
  const defaultZone = piece
    ? defaultDestination(view.catalog, piece)
    : "battlefield";
  return (
    <li className="ptc-stack-entry">
      <div className="ptc-stack-meta">
        <span>{top ? "Top" : "Below"}</span> ·{" "}
        {entry.copyKind ? entry.copyKind + " copy" : entry.kind} · P
        {entry.controller + 1}
      </div>
      {card ? (
        <StackCardName
          label={entry.label}
          reading={
            <CardReading
              {...card}
              art={
                <CardImage
                  card={card}
                  imageCacheDir={imageCacheDir}
                  face={
                    (entry.copyBack || piece?.back) && card.backImageUri
                      ? "back"
                      : "front"
                  }
                />
              }
            />
          }
        />
      ) : (
        <strong>{entry.label}</strong>
      )}
      {entry.kind === "ability" && piece && (
        <small>From {cardName(view, piece.id)}</small>
      )}
      {entry.description && entry.description !== entry.label && (
        <small>{entry.description}</small>
      )}
      {entry.targets && <small>Targeting {entry.targets}</small>}
      <div className="ptc-row ptc-stack-actions">
        {top && (
          <>
            {entry.kind === "spell" && (
              <select
                aria-label={`Resolution destination for ${entry.label}`}
                value={destination || defaultZone}
                onChange={(e) => setDestination(e.target.value as Zone)}
              >
                <option value="battlefield">To battlefield</option>
                <option value="graveyard">To graveyard</option>
                <option value="exile">To exile</option>
                <option value="hand">To hand</option>
                <option value="library">To library top</option>
              </select>
            )}
            <button
              type="button"
              className="ptc-accent"
              onClick={() =>
                dispatch({
                  type: "resolve",
                  entry: entry.id,
                  zone:
                    entry.kind === "spell"
                      ? destination || defaultZone
                      : undefined,
                })
              }
            >
              Resolve
            </button>
          </>
        )}
        <button
          type="button"
          title="Copy onto the stack"
          onClick={() =>
            dispatch({ type: "copy", entry: entry.id, seat: viewer })
          }
        >
          <Copy size={13} /> Copy
        </button>
        <button
          type="button"
          onClick={() => {
            setTargetDraft(entry.targets);
            setEditing(!editing);
          }}
        >
          Targets
        </button>
        <button
          type="button"
          onClick={() => dispatch({ type: "counterSpell", entry: entry.id })}
        >
          Counter
        </button>
        {view.stack.length > 1 && (
          <>
            <button
              type="button"
              aria-label={`Move ${entry.label} up the stack`}
              title="Move up the stack"
              disabled={top}
              onClick={() =>
                dispatch({
                  type: "reorderStack",
                  entry: entry.id,
                  direction: "up",
                })
              }
            >
              <ArrowUp size={13} />
            </button>
            <button
              type="button"
              aria-label={`Move ${entry.label} down the stack`}
              title="Move down the stack"
              disabled={entry === view.stack.at(-1)}
              onClick={() =>
                dispatch({
                  type: "reorderStack",
                  entry: entry.id,
                  direction: "down",
                })
              }
            >
              <ArrowDown size={13} />
            </button>
          </>
        )}
      </div>
      {editing && (
        <form
          className="ptc-form"
          onSubmit={(e) => {
            e.preventDefault();
            dispatch({
              type: "targets",
              entry: entry.id,
              targets: targetDraft.trim(),
            });
            setEditing(false);
          }}
        >
          <label>
            Targets
            <input
              autoFocus
              list={targetList}
              maxLength={240}
              value={targetDraft}
              onChange={(e) => setTargetDraft(e.target.value)}
            />
          </label>
          <button type="submit">Apply</button>
        </form>
      )}
    </li>
  );
}

export function StackControls(props: ControlProps & { imageCacheDir: string }) {
  const { view, viewer } = props;
  const targetList = useId();
  return (
    <StackPanel count={view.stack.length}>
      <datalist id={targetList}>
        {targetSuggestions(view).map((text) => (
          <option key={text} value={text} />
        ))}
      </datalist>
      {view.stack.length > 0 && (
        <ol className="ptc-stack-list">
          {view.stack.map((entry, index) => (
            <StackItem
              key={entry.id}
              {...props}
              entry={entry}
              top={index === 0}
              targetList={targetList}
            />
          ))}
        </ol>
      )}
      <StackComposer key={viewer} {...props} targetList={targetList} />
    </StackPanel>
  );
}
