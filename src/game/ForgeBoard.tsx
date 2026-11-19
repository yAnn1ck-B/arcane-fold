import { Fragment, useEffect, useId, useRef, useState, type Ref } from "react";
import {
  CircleHelp,
  ImageOff,
  Layers,
  RotateCcw,
  Search,
  Target,
} from "lucide-react";
import CardImage from "@/components/CardImage";
import { Button } from "@/components/ui/button";
import { database } from "@/services/database";
import {
  LifeValue,
  StackPanel,
  SwitchPlayer,
  TableBoard,
  TableSeat,
  ZoneCounter,
  type MatchTools,
} from "./TableBoard";
import { ForgeOpeningHand } from "./OpeningHandDialog";
import { TableCard } from "./TableCards";
import { CardReading, StackCardName } from "./CardPreview";
import { TableDialog } from "./TableDialog";
import { ManaPip, ManaPool, manaNames } from "./ManaPool";
import { manaTypes } from "./types";
import { battlefieldGroup } from "./battlefield";
import { prioritySteps, type PriorityStop } from "./forge-match";
import type {
  ForgeCard,
  ForgeChoice,
  ForgeMatch,
  ForgeSeat,
} from "./forge-match";

type Artwork = {
  id: string;
  name: string;
  manaCost: string;
  typeLine: string;
  oracleText: string;
  imageUri: string | null;
};
type ArtCache = Map<string, Promise<Artwork | undefined>>;
const pileNames = { graveyard: "Graveyard", exile: "Exile", library: "Top of library" } as const;
type Pile = { seat: ForgeSeat; zone: keyof typeof pileNames };

function priorityExplanation(stop: PriorityStop) {
  switch (stop) {
    case "auto": return "Forge pauses when you have a play or response, including tapping a mana source in your main phase.";
    case "next": return "Pause once at your next opportunity on either turn. Choose a particular step to wait until that point instead. After the stop, Automatic resumes.";
    case "full": return "Forge pauses every time you get priority, even if you can only pass, until you change this setting.";
    default: return `Forge adds one pause at “${prioritySteps[stop]}” the next time you get priority at that step, then returns to Automatic.`;
  }
}

function AbilityLabel({ label }: { label: string }) {
  const separator = label.indexOf(":");
  if (separator < 1) return <span>{label}</span>;
  return (
    <>
      <strong>{label.slice(0, separator)}</strong>
      <span>{label.slice(separator + 1).trim()}</span>
    </>
  );
}

function TypeChoice({
  choices,
  locked,
  choose,
}: {
  choices: ForgeChoice[];
  locked: boolean;
  choose: (choice: ForgeChoice) => void;
}) {
  const list = useId();
  const [value, setValue] = useState("");
  const query = value.trim().toLowerCase();
  const selected = choices.find(
    (choice) => choice.label.toLowerCase() === query,
  );
  return (
    <form
      className="pt-forge-options"
      onSubmit={(event) => {
        event.preventDefault();
        if (selected && !locked) choose(selected);
      }}
    >
      <input
        list={list}
        aria-label="Find a type"
        placeholder="Find a type"
        autoComplete="off"
        disabled={locked}
        value={value}
        onChange={(event) => setValue(event.target.value)}
      />
      <datalist id={list}>
        {choices.map((choice) => (
          <option key={choice.id} value={choice.label} />
        ))}
      </datalist>
      <Button type="submit" disabled={locked || !selected}>
        Choose type
      </Button>
    </form>
  );
}

function pileLabel(seat: ForgeSeat, viewer: ForgeSeat, zone: Pile["zone"]) {
  return `${seat === viewer ? "Your" : "Opponent's"} ${zone}`;
}

function NameChoice({
  choice, locked, submit,
}: {
  choice: ForgeChoice;
  locked: boolean;
  submit: (action: string) => void;
}) {
  const [value, setValue] = useState("");
  const name = value.trim();
  const action = `${choice.id}|${name}`;
  const valid = !!name && !name.includes("|") && new TextEncoder().encode(action).length <= 512;
  return (
    <form
      className="pt-forge-options"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid && !locked) submit(action);
      }}
    >
      <input
        aria-label="Card name" placeholder="Card name" value={value} maxLength={512}
        disabled={locked} onChange={(event) => setValue(event.target.value)}
      />
      <Button type="submit" disabled={!valid || locked}>Choose name</Button>
    </form>
  );
}

function ForgeArt({
  card,
  imageCacheDir,
  cache,
  inspect = false,
  attachments = [],
}: {
  card: ForgeCard;
  imageCacheDir: string;
  cache: ArtCache;
  inspect?: boolean;
  attachments?: string[];
}) {
  const { name, setCode = "", collectorNumber = "" } = card;
  const [art, setArt] = useState<Artwork>();
  useEffect(() => {
    if (card.faceDown) return;
    const key = JSON.stringify([name, setCode, collectorNumber]);
    let request = cache.get(key);
    if (!request) {
      request = database()
        .then(async (db) => {
          const [row] = await db.select<Artwork[]>(
            `SELECT id, name, mana_cost AS manaCost, type_line AS typeLine, oracle_text AS oracleText, image_uri AS imageUri FROM cards
           WHERE (name = ? COLLATE NOCASE OR (set_code = ? COLLATE NOCASE AND collector_number = ?))
           ORDER BY (set_code = ? COLLATE NOCASE) DESC, (collector_number = ?) DESC,
             (name = ? COLLATE NOCASE) DESC, (image_uri IS NOT NULL) DESC, set_code, collector_number, id LIMIT 1`,
            [name, setCode, collectorNumber, setCode, collectorNumber, name],
          );
          return row;
        })
        .catch(() => {
          cache.delete(key);
          return undefined;
        });
      cache.set(key, request);
    }
    let active = true;
    setArt(undefined);
    void request.then((result) => {
      if (active) setArt(result);
    });
    return () => {
      active = false;
    };
  }, [cache, name, setCode, collectorNumber, card.faceDown]);
  if (card.faceDown) {
    const back = (
      <div className="pt-card-back">
        <Layers size={25} aria-hidden />
      </div>
    );
    return inspect ? <CardReading name="Face-down card" art={back} /> : back;
  }
  const image = art?.imageUri ? (
    <CardImage card={art} imageCacheDir={imageCacheDir} />
  ) : (
    <div className="card-image">
      <div className="card-image-placeholder">
        <ImageOff size={20} aria-hidden />
        <span>{name}</span>
      </div>
    </div>
  );
  return inspect ? (
    <CardReading
      name={card.token ? `${name} · Token` : name}
      art={image}
      manaCost={art?.manaCost || card.manaCost}
      typeLine={card.typeLine || art?.typeLine}
      oracleText={card.token ? card.oracleText : art?.oracleText || card.oracleText}
      details={[
        ...attachments,
        ...(card.chosenColors?.map((color) => `Chosen color · ${color}`) ?? []),
        ...(card.namedCards?.map((named) => `Named card · ${named}`) ?? []),
      ]}
      damage={card.damage}
      counters={card.counters}
      stats={
        card.power != null && card.toughness != null
          ? `${card.power}/${card.toughness}`
          : undefined
      }
    />
  ) : (
    image
  );
}

export default function ForgeBoard({
  state,
  locked,
  onChoose,
  onPriorityStop,
  replay,
  imageCacheDir,
  viewer,
  onSwitch,
  matchTools,
}: {
  state: ForgeMatch;
  locked: boolean;
  onChoose: (id: string) => void;
  onPriorityStop: (stop: PriorityStop) => void;
  replay: () => void;
  imageCacheDir: string;
  viewer: ForgeSeat;
  onSwitch?: () => void;
  matchTools: MatchTools;
}) {
  const [showPriorityHelp, setShowPriorityHelp] = useState(false);
  const priorityId = useId();
  const priorityHelpId = useId();
  const [pile, setPile] = useState<Pile | null>(null);
  const [menuCard, setMenuCard] = useState<ForgeCard | null>(null);
  const [deferredSearch, setDeferredSearch] = useState<string>();
  const [cardFilter, setCardFilter] = useState("");
  const firstButton = useRef<HTMLButtonElement>(null);
  const focusedRevision = useRef<number | undefined>(undefined);
  const cache = useRef<ArtCache>(new Map());
  const { actor, players, stack, choices, librarySearch, sharedSeats } = state;
  const searchId = librarySearch ? choices[0]?.id : undefined;
  const libraryOperation = librarySearch?.operation ?? "Library search";
  const showSearch = !!librarySearch && deferredSearch !== searchId;
  const filter = cardFilter.trim().toLowerCase();
  const searchCards =
    librarySearch?.cards.filter((card) =>
      card.name.toLowerCase().includes(filter),
    ) ?? [];
  const handSeat = viewer;
  const seatOrder: ForgeSeat[] =
    viewer === "player" ? ["opponent", "player"] : ["player", "opponent"];
  const hand = players[handSeat].hand;
  const battlefield = [...players.player.battlefield, ...players.opponent.battlefield];
  const pieces = new Map(battlefield.map((piece) => [piece.id, piece]));
  const attachments = new Map<string, string[]>();
  for (const piece of battlefield) {
    if (piece.attachedTo) attachments.set(piece.attachedTo, [...(attachments.get(piece.attachedTo) ?? []), piece.name]);
  }
  const opening =
    state.stage === "decision" &&
    state.phase === "Opening hand" &&
    viewer === actor &&
    choices.length > 0;
  const handLabel = sharedSeats
    ? `Player ${viewer === "player" ? 1 : 2} hand`
    : "Your hand";
  const pileOwner = pile && players[pile.seat];
  const pileCards = pile && pileOwner
    ? pile.zone === "library"
      ? pileOwner.libraryTop ? [pileOwner.libraryTop] : []
      : pileOwner[pile.zone] ?? []
    : [];
  const visibleCards = new Set(
    [
      ...hand,
      ...stack,
      ...pileCards,
      ...(librarySearch?.cards ?? []),
      ...battlefield,
    ].map((card) => card.id),
  );
  const isLifeTarget = (choice: ForgeChoice) =>
    choice.kind === "target" && !!choice.seat && !choice.cardId;
  const typeChoices = choices.filter((choice) => choice.kind === "type");
  const manaColors = choices.filter((choice) => choice.kind === "manaColor");
  const nameChoice = choices.find((choice) => choice.kind === "name");
  const toolbar = librarySearch
    ? []
    : choices.filter(
        (choice) =>
          choice.kind !== "type" && choice.kind !== "name" && choice.kind !== "manaColor" &&
          !isLifeTarget(choice) &&
          (!choice.cardId || !visibleCards.has(choice.cardId)),
      );
  const menuChoices = menuCard
    ? choices.filter((choice) => choice.cardId === menuCard.id)
    : [];
  const choosingAbility = menuChoices.some(
    (choice) => choice.kind === "ability",
  );
  const initialChoice = choices[0]?.id;
  const focusFor = (choice?: ForgeChoice) =>
    choice && choice.id === initialChoice ? firstButton : undefined;
  const switchButton = (focusRef?: Ref<HTMLButtonElement>) =>
    onSwitch && (
      <SwitchPlayer
        player={viewer === "player" ? 2 : 1}
        onSwitch={onSwitch}
        disabled={locked}
        focusRef={focusRef}
      />
    );

  useEffect(() => {
    const button = firstButton.current;
    if (
      !locked &&
      focusedRevision.current !== state.revision &&
      button &&
      !button.closest("[hidden]") &&
      !document.querySelector("dialog[open]")
    ) {
      // Advance keyboard focus without opening a card reading over a new decision.
      focusedRevision.current = state.revision;
      button.dataset.autoFocus = "";
      button.focus({ preventScroll: true });
      delete button.dataset.autoFocus;
    }
  }, [state.revision, locked]);

  useEffect(() => {
    setCardFilter("");
  }, [searchId]);

  function choose(choice: ForgeChoice) {
    setMenuCard(null);
    setPile(null);
    onChoose(choice.id);
  }

  function option(choice: ForgeChoice, focusRef?: Ref<HTMLButtonElement>) {
    if (choice.kind === "pass") {
      const ending = state.phase === "Ending phase";
      const endTurn = (state.priorityStop === "auto" || ending) && choice.endTurnId;
      const lastAdvance = !!endTurn && (ending || state.phase === "Postcombat main phase");
      const label = stack.length ? "Resolve" : state.active === viewer ? "Next" : "Pass";
      return (
        <Fragment key={choice.id}>
          <Button
            ref={focusRef}
            className="pt-advance"
            variant="outline"
            disabled={locked}
            onClick={() => onChoose(lastAdvance ? endTurn : choice.id)}
          >
            {lastAdvance ? "End Turn" : label}
          </Button>
          {endTurn && !lastAdvance && (
            <Button variant="outline" disabled={locked} onClick={() => onChoose(endTurn)}>
              End Turn
            </Button>
          )}
        </Fragment>
      );
    }
    return (
      <Button
        key={choice.id}
        ref={focusRef}
        disabled={locked}
        onClick={() => choose(choice)}
      >
        {choice.label}
      </Button>
    );
  }

  function tile(card: ForgeCard) {
    const name = card.faceDown ? "Face-down card" : card.name;
    const actions = choices.filter((choice) => choice.cardId === card.id);
    const move = actions[0];
    const abilityCount = actions.filter(
      (choice) => choice.kind === "ability",
    ).length;
    const stats =
      card.power != null && card.toughness != null
        ? `${card.power}/${card.toughness}`
        : "";
    const combat = card.attacking
      ? "Attacking"
      : card.blocking
        ? "Blocking"
        : "";
    const combatLabel =
      card.blocking && card.target ? `Blocking ${card.target}` : combat;
    const attached = attachments.get(card.id) ?? [];
    const attachedTo = card.attachedTo ? pieces.get(card.attachedTo)?.name
      : card.attachedToPlayer && (card.attachedToPlayer === viewer ? "you" : "opponent");
    const description = [
      name, card.token && "Token", stats, card.tapped && "Tapped", combatLabel,
      attachedTo && `Attached to ${attachedTo}`, ...attached,
    ]
      .filter(Boolean)
      .join(", ");
    const actionLabel =
      actions.length > 1
        ? `Choose ${abilityCount === actions.length ? "an ability" : "action"} for ${name}`
        : move?.label;
    const attachmentLabels = [
      ...(attachedTo ? [`Attached to ${attachedTo}`] : []),
      ...(attached.length ? [`Attachments · ${attached.join(", ")}`] : []),
    ];
    const label = actionLabel
      ? [actionLabel, card.token && "Token", ...attachmentLabels].filter(Boolean).join(", ")
      : description;
    return (
      <TableCard
        key={card.id}
        name={name}
        label={label}
        tapped={card.tapped}
        opensDialog={actions.length > 1}
        reading={
          <ForgeArt
            card={card}
            cache={cache.current}
            imageCacheDir={imageCacheDir}
            inspect
            attachments={attachmentLabels}
          />
        }
        flags={
          <>
            {combat && <span>{combat}</span>}
            {card.token && <span>Token</span>}
            {attachedTo && <span>Attached to {attachedTo}</span>}
            {attached.length > 0 && <span>{attached.join(", ")}</span>}
            {stats && <span>{stats}</span>}
            {card.chosenType && <span>Chosen type · {card.chosenType}</span>}
            {abilityCount > 1 && <span>{abilityCount} abilities</span>}
            {actions.length === 1 && move.manaAbility && <span>Add mana</span>}
          </>
        }
        disabled={locked}
        focusRef={
          actions.some((c) => c.id === initialChoice) ? firstButton : undefined
        }
        onClick={
          move
            ? () => (actions.length === 1 ? choose(move) : setMenuCard(card))
            : undefined
        }
        art={
          <ForgeArt
            card={card}
            cache={cache.current}
            imageCacheDir={imageCacheDir}
          />
        }
      />
    );
  }

  function renderSeat(seat: ForgeSeat) {
    const own = seat === viewer;
    const data = players[seat];
    const targets = choices.filter(
      (choice) => isLifeTarget(choice) && choice.seat === seat,
    );
    const life = <LifeValue life={data.life} />;
    return (
      <TableSeat
        key={seat}
        own={own}
        player={seat === "player" ? 1 : 2}
        piles={
          <>
            {data.libraryCount != null && (
              <ZoneCounter
                zone="library"
                count={data.libraryCount}
                label={`${own ? "Your" : "Opponent's"} library, ${data.libraryCount} cards${data.libraryTop ? " · View top card" : ""}`}
                open={pile?.seat === seat && pile.zone === "library"}
                onOpen={data.libraryTop ? () => setPile({ seat, zone: "library" }) : undefined}
              />
            )}
            <ZoneCounter
              zone="hand"
              count={data.handCount}
              label={`${own ? "Your" : "Opponent's"} hand, ${data.handCount} cards`}
            />
            {(["graveyard", "exile"] as const).map((zone) => {
              const cards = data[zone];
              if (!cards) return null;
              return (
                <ZoneCounter
                  key={zone}
                  zone={zone}
                  count={cards.length}
                  open={pile?.seat === seat && pile.zone === zone}
                  label={`${pileLabel(seat, viewer, zone)}, ${cards.length} ${cards.length === 1 ? "card" : "cards"}`}
                  onOpen={() => setPile({ seat, zone })}
                />
              );
            })}
          </>
        }
        resources={
          <div className="ptc ptc-player">
            <div className="ptc-row">
              {targets.length ? (
                targets.map((choice) => (
                  <button
                    type="button"
                    key={choice.id}
                    className="ptc-accent"
                    aria-label={choice.label}
                    ref={focusFor(choice)}
                    disabled={locked}
                    onClick={() => choose(choice)}
                  >
                    <Target size={14} />
                    {choice.label} · {life}
                  </button>
                ))
              ) : (
                <div className="ptc-life">{life}</div>
              )}
              <ManaPool player={seat === "player" ? 1 : 2} amounts={data.manaByColor} total={data.mana} />
            </div>
          </div>
        }
        cards={data.battlefield.map((card) => ({
          group: battlefieldGroup(card),
          tile: tile(card),
        }))}
      />
    );
  }

  const stop = state.priorityStop ?? "auto";
  const oneTimeStop = stop !== "auto" && stop !== "full";
  const priorityControl = state.stage === "decision" && (
    <div className="ptc pt-priority-control">
      <div className="pt-priority-heading">
        <label htmlFor={priorityId}>Stops</label>
        <button
          type="button"
          aria-label="Explain stops"
          title="Explain stops"
          aria-expanded={showPriorityHelp}
          aria-controls={priorityHelpId}
          onClick={() => setShowPriorityHelp((open) => !open)}
        >
          <CircleHelp size={15} aria-hidden />
        </button>
      </div>
      <select
        id={priorityId}
        aria-describedby={showPriorityHelp ? priorityHelpId : undefined}
        value={oneTimeStop ? "next" : stop}
        disabled={locked}
        onChange={(event) => onPriorityStop(event.currentTarget.value as PriorityStop)}
      >
        <option value="auto">Automatic</option>
        <option value="next">Set a stop</option>
        <option value="full">Full Control</option>
      </select>
      {oneTimeStop && (
        <select
          aria-label="When to stop"
          value={stop}
          disabled={locked}
          onChange={(event) => onPriorityStop(event.currentTarget.value as PriorityStop)}
        >
          <option value="next">Next opportunity</option>
          {Object.entries(prioritySteps).map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
      )}
      <p id={priorityHelpId} hidden={!showPriorityHelp}>
        Priority is your chance to cast a spell or activate an ability on either player’s turn.{" "}
        {priorityExplanation(stop)}
      </p>
    </div>
  );

  return (
    <TableBoard
      label="Forge game"
      switchPlayer={switchButton(!choices.length && state.stage === "decision" ? firstButton : undefined)}
      matchTools={matchTools}
      stackCount={stack.length}
      toolbar={
        <div className="pt-forge-controls">
          <div className="ptc ptc-turn" aria-label="Turn, phase and step">
            {state.turn > 0 && (
              <span className="ptc-turn-number">
                Turn <strong>{state.turn}</strong>
              </span>
            )}
            <span className="ptc-turn-player">
              {[state.phase, state.step].filter(Boolean).join(" · ")}
              {state.turn > 0 && (
                <small>
                  {sharedSeats
                    ? `Player ${state.active === "player" ? 1 : 2}'s turn`
                    : state.active === "opponent"
                      ? "Opponent's turn"
                      : "Your turn"}
                </small>
              )}
            </span>
          </div>
          {!opening && priorityControl}
          {!opening && (
            <div className="pt-forge-prompt">
              {state.stage === "decision" &&
                (!sharedSeats || viewer === actor) && (
                  <strong>
                    {sharedSeats
                      ? `Player ${actor === "player" ? 1 : 2} to act`
                      : actor === "opponent"
                        ? "Opponent"
                        : "You"}
                  </strong>
                )}
              <span role="status">{state.prompt}</span>
              {!!state.revealedToYou?.length && (
                <small>Revealed to you: {state.revealedToYou.join(", ")}</small>
              )}
            </div>
          )}
          <div className="pt-forge-options">
            {librarySearch && !showSearch && (
              <Button
                variant="outline"
                onClick={() => setDeferredSearch(undefined)}
              >
                View {libraryOperation.toLowerCase()}
              </Button>
            )}
            {opening ? (
              <ForgeOpeningHand
                seat={viewer}
                prompt={state.prompt}
                hand={hand.map(tile)}
                choices={toolbar}
                onChoose={choose}
                locked={locked}
                error={matchTools.openingRecovery}
              />
            ) : (
              toolbar.map((choice) => option(choice, focusFor(choice)))
            )}
            {typeChoices.length > 0 && (
              <TypeChoice
                key={typeChoices[0].id}
                choices={typeChoices}
                locked={locked}
                choose={choose}
              />
            )}
            {nameChoice && <NameChoice key={nameChoice.id} choice={nameChoice} locked={locked} submit={onChoose} />}
            {state.stage === "finished" && (
              <Button
                ref={firstButton}
                disabled={locked}
                variant="outline"
                onClick={replay}
              >
                <RotateCcw size={15} /> Play again
              </Button>
            )}
          </div>
        </div>
      }
      seats={seatOrder.map(renderSeat)}
      handLabel={handLabel}
      handCount={players[handSeat].handCount}
      hand={
        opening
          ? [
              <span key="opening" className="pt-empty">
                Review your opening hand
              </span>,
            ]
          : hand.map(tile)
      }
      stack={
        <StackPanel count={stack.length}>
          {stack.length > 0 && (
            <ol className="ptc-stack-list">
              {stack.map((card, index) => {
                const actions = choices.filter(
                  (choice) => choice.cardId === card.id,
                );
                return (
                  <li key={card.id} className="ptc-stack-entry">
                    {index === 0 && (
                      <div className="ptc-stack-meta">
                        <span>Top</span>
                      </div>
                    )}
                    <StackCardName
                      label={card.name}
                      reading={
                        <ForgeArt
                          card={card}
                          cache={cache.current}
                          imageCacheDir={imageCacheDir}
                          inspect
                        />
                      }
                    />
                    {card.description && <small>{card.description}</small>}
                    {card.target && <small>Targeting {card.target}</small>}
                    {actions.map((choice) => option(choice, focusFor(choice)))}
                  </li>
                );
              })}
            </ol>
          )}
        </StackPanel>
      }
    >
      {manaColors.length > 0 && (
        <TableDialog title={state.prompt} subtitle={`Player ${viewer === "player" ? 1 : 2}`} className="pt-mana-dialog">
          {matchTools.openingRecovery}
          <div className="pt-mana-colors">
            {manaColors.map((choice) => {
              const color = manaTypes.find((type) => manaNames[type].toLowerCase() === choice.label.toLowerCase());
              return (
                <button type="button" className="pt-btn" key={choice.id} disabled={locked} onClick={() => choose(choice)}>
                  {color && <ManaPip color={color} />} {color ? manaNames[color] : choice.label}
                </button>
              );
            })}
          </div>
        </TableDialog>
      )}
      {menuCard && menuChoices.length > 0 && (
        <TableDialog
          title={
            choosingAbility
              ? "Choose an ability"
              : `Actions for ${menuCard.name}`
          }
          subtitle={choosingAbility ? menuCard.name : undefined}
          closeLabel={choosingAbility ? "Cancel ability selection" : "Close"}
          onClose={() => setMenuCard(null)}
        >
          {choosingAbility ? (
            <div className="pt-ability-options">
              {menuChoices.map((choice) => (
                <button
                  type="button"
                  key={choice.id}
                  disabled={locked}
                  className="pt-ability-option"
                  aria-label={choice.label}
                  onClick={() => choose(choice)}
                >
                  <AbilityLabel label={choice.label} />
                </button>
              ))}
            </div>
          ) : (
            <div className="pt-forge-options">
              {menuChoices.map((choice) => option(choice))}
            </div>
          )}
        </TableDialog>
      )}
      {pile && (
        <TableDialog
          title={pileNames[pile.zone]}
          label={pileLabel(pile.seat, viewer, pile.zone)}
          subtitle={`${pile.seat === "player" ? "Player 1" : "Player 2"} · ${pileCards.length} ${pileCards.length === 1 ? "card" : "cards"}`}
          closeLabel="Close zone"
          onClose={() => setPile(null)}
        >
          {pileCards.length ? (
            <div className="pt-field">{pileCards.map(tile)}</div>
          ) : (
            <p className="pt-subtle">This zone is empty.</p>
          )}
        </TableDialog>
      )}
      {librarySearch && showSearch && (
        <TableDialog
          title={librarySearch.title}
          label={libraryOperation}
          closeLabel={`Close ${libraryOperation.toLowerCase()}`}
          onClose={() => setDeferredSearch(searchId)}
        >
          {state.prompt !== librarySearch.title && (
            <p className="pt-search-prompt">{state.prompt}</p>
          )}
          {libraryOperation === "Library search" &&
            librarySearch.cards.length > 0 && (
              <label className="pt-query">
                <Search size={16} />
                <input
                  type="search"
                  aria-label="Filter library cards"
                  placeholder="Find a card"
                  value={cardFilter}
                  onChange={(e) => setCardFilter(e.target.value)}
                />
              </label>
            )}
          {searchCards.length ? (
            <div className="pt-field">{searchCards.map(tile)}</div>
          ) : (
            <p className="pt-subtle">
              {librarySearch.cards.length
                ? "No matching cards."
                : "No eligible cards."}
            </p>
          )}
          <div className="pt-search-actions">
            {choices
              .filter((choice) => !choice.cardId)
              .map((choice) => option(choice))}
          </div>
        </TableDialog>
      )}
    </TableBoard>
  );
}
