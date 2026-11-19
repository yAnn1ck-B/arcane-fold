import { createContext, Fragment, useContext, useEffect, useId, useRef, useState, type Ref } from "react";
import {
  ImageOff,
  Layers,
  Search,
  Target,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  LifeValue,
  StackPanel,
  SwitchPlayer,
  TableBoard,
  TableSeat,
  TurnSummary,
  ZoneCounter,
  type MatchTools,
} from "./TableBoard";
import { ForgeOpeningHand } from "./OpeningHandDialog";
import { TableCard } from "./TableCards";
import { CardReading, StackCardName } from "./CardPreview";
import { cardStatuses } from "./CardStatus";
import { TableDialog } from "./TableDialog";
import { ManaPip, ManaPool, manaNames } from "./ManaPool";
import { manaTypes } from "./types";
import { battlefieldGroup } from "./battlefield";
import type { PriorityStop } from "./forge-match";
import type {
  ForgeCard,
  ForgeChoice,
  ForgeMatch,
  ForgeSeat,
} from "./forge-match";

export const ForgeImageSource = createContext<((card: ForgeCard) => string) | undefined>(undefined);

const pileNames = { graveyard: "Graveyard", exile: "Exile", library: "Top of library" } as const;
type Pile = { seat: ForgeSeat; zone: keyof typeof pileNames };

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
  inspect = false,
  attachments = [],
}: {
  card: ForgeCard;
  inspect?: boolean;
  attachments?: string[];
}) {
  const { name } = card;
  const imageSource = useContext(ForgeImageSource);
  const [failedImage, setFailedImage] = useState<string>();
  if (card.faceDown) {
    const back = (
      <div className="pt-card-back">
        <Layers size={25} aria-hidden />
      </div>
    );
    return inspect ? <CardReading name="Face-down card" art={back} details={cardStatuses(card).map(s => s.label)} /> : back;
  }
  const url = imageSource?.(card);
  const image = url && url !== failedImage ? (
    <div className="card-image">
      <img src={url} alt={name} loading="lazy" onError={() => setFailedImage(url)} />
    </div>
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
      manaCost={card.manaCost}
      typeLine={card.typeLine}
      oracleText={card.oracleText}
      details={[
        ...attachments,
        ...cardStatuses(card).filter(s => s.kind !== "counter" && s.kind !== "damage").map(s => s.label),
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
  viewer,
  onSwitch,
  matchTools,
}: {
  state: ForgeMatch;
  locked: boolean;
  onChoose: (id: string) => void;
  onPriorityStop: (stop: PriorityStop) => Promise<boolean>;
  viewer: ForgeSeat;
  onSwitch?: () => void;
  matchTools: MatchTools;
}) {
  const [pile, setPile] = useState<Pile | null>(null);
  const [menuCard, setMenuCard] = useState<ForgeCard | null>(null);
  const [deferredSearch, setDeferredSearch] = useState<string>();
  const [cardFilter, setCardFilter] = useState("");
  const firstButton = useRef<HTMLButtonElement>(null);
  const focusedRevision = useRef<number | undefined>(undefined);
  const { actor, players, stack, choices, librarySearch, sharedSeats } = state;
  const { seatNames } = matchTools;
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
  const handLabel = `${seatNames[viewer]}'s hand`;
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
        playerName={seatNames[viewer === "player" ? "opponent" : "player"]}
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
      const endTurn = (!state.priorityStop.own.length || ending) && choice.endTurnId;
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
    const statuses = cardStatuses(card);
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
      : card.attachedToPlayer && seatNames[card.attachedToPlayer];
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
        label={[label, ...statuses.map(s => s.label)].join(", ")}
        statuses={statuses}
        tapped={card.tapped}
        opensDialog={actions.length > 1}
        reading={
          <ForgeArt
            card={card}
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
        playerName={seatNames[seat]}
        piles={
          <>
            {data.libraryCount != null && (
              <ZoneCounter
                zone="library"
                count={data.libraryCount}
                label={`${seatNames[seat]}'s library, ${data.libraryCount} cards${data.libraryTop ? " · View top card" : ""}`}
                open={pile?.seat === seat && pile.zone === "library"}
                onOpen={data.libraryTop ? () => setPile({ seat, zone: "library" }) : undefined}
              />
            )}
            <ZoneCounter
              zone="hand"
              count={data.handCount}
              label={`${seatNames[seat]}'s hand, ${data.handCount} cards`}
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
                  label={`${seatNames[seat]}'s ${zone}, ${cards.length} ${cards.length === 1 ? "card" : "cards"}`}
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
              <ManaPool playerName={seatNames[seat]} amounts={data.manaByColor} total={data.mana} />
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

  return (
    <TableBoard
      label="Forge game"
      switchPlayer={switchButton(!choices.length && state.stage === "decision" ? firstButton : undefined)}
      matchTools={matchTools}
      stackCount={stack.length}
      toolbar={<TurnSummary turn={state.turn} activeName={seatNames[state.active]} />}
      priorityControl={state.stage === "decision" ? {
        stops: state.priorityStop, locked, opponentName: seatNames[viewer === "player" ? "opponent" : "player"],
        error: matchTools.decisionError, onSave: onPriorityStop,
      } : undefined}
      actions={
        <>
          {!opening && (!matchTools.actionStatus || !!state.revealedToYou?.length) && (
            <div className="pt-forge-prompt">
              {!matchTools.actionStatus && state.stage === "decision" &&
                (!sharedSeats || viewer === actor) && (
                  <strong>
                    {seatNames[actor]} to act
                  </strong>
                )}
              {!matchTools.actionStatus && <span role="status">{state.prompt}</span>}
              {!!state.revealedToYou?.length && (
                <small>Revealed to you: {state.revealedToYou.join(", ")}</small>
              )}
            </div>
          )}
          <div className="pt-forge-options pt-turn-actions">
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
                playerName={seatNames[viewer]}
                prompt={state.prompt}
                hand={hand.map(tile)}
                choices={toolbar}
                onChoose={choose}
                locked={locked}
                error={matchTools.decisionError}
                allowTable
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
          </div>
        </>
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
        <TableDialog title={state.prompt} subtitle={seatNames[viewer]} className="pt-mana-dialog">
          {matchTools.decisionError}
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
          label={`${seatNames[pile.seat]}'s ${pile.zone}`}
          subtitle={`${seatNames[pile.seat]} · ${pileCards.length} ${pileCards.length === 1 ? "card" : "cards"}`}
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
