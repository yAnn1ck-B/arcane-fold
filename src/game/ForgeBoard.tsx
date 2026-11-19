import { createContext, Fragment, useContext, useEffect, useId, useRef, useState, type Ref } from "react";
import {
  ImageOff,
  Layers,
  Search,
  Target,
  UserRound,
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
import { groupBattlefieldCards } from "./battlefield-groups";
import { CombatLinks } from "./CombatLinks";
import { CombatDamageDialog } from "./CombatDamageDialog";
import type { PriorityStop } from "./forge-match";
import type {
  ForgeCard,
  ForgeChoice,
  ForgeDamageRecipient,
  ForgeMatch,
  ForgeSeat,
} from "./forge-match";

export const ForgeImageSource = createContext<((card: ForgeCard) => string) | undefined>(undefined);

type Pile = { seat: ForgeSeat; zone: "graveyard" | "exile" | "library" };

function targetMark(legal: boolean, stacked: boolean) {
  return {
    className: [legal && "pt-legal-target", stacked && "pt-stack-target"].filter(Boolean).join(" "),
    labels: [legal && "Legal target", stacked && "Targeted on stack"].filter(Boolean),
  };
}

function CardActionLabel({ choice }: { choice: ForgeChoice }) {
  const { label } = choice;
  const separator = choice.kind === "ability" ? label.indexOf(":") : -1;
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
    return inspect ? <CardReading name="Face-down card" art={back} statuses={cardStatuses(card)} /> : back;
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
        ...(card.chosenColors?.map((color) => `Chosen color · ${color}`) ?? []),
        ...(card.namedCards?.map((named) => `Named card · ${named}`) ?? []),
      ]}
      statuses={cardStatuses(card)}
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
  const [openStack, setOpenStack] = useState<{ id: string; revision: number } | null>(null);
  const [menuCard, setMenuCard] = useState<ForgeCard | null>(null);
  const [deferredSearch, setDeferredSearch] = useState<string>();
  const [cardFilter, setCardFilter] = useState("");
  const [blockSelection, setBlockSelection] = useState<{ id: string; revision: number } | null>(null);
  const [showBlockList, setShowBlockList] = useState(false);
  const [dismissedDamage, setDismissedDamage] = useState<string>();
  const firstButton = useRef<HTMLButtonElement>(null);
  const firstBlockTarget = useRef<HTMLButtonElement>(null);
  const focusedRevision = useRef<number | undefined>(undefined);
  const { actor, players, stack, librarySearch, sharedSeats } = state;
  const damageAssignment = viewer === actor && state.stage === "decision" ? state.damageAssignment : undefined;
  const showDamageAssignment = !!damageAssignment && damageAssignment.choiceId !== dismissedDamage;
  const choices = viewer === actor && !damageAssignment ? state.choices : [];
  const legalTargets = locked ? [] : choices.filter((choice) => choice.kind === "target");
  const legalCards = new Set(legalTargets.map((choice) => choice.cardId));
  const stackTargets = stack.flatMap((card) => card.targetRefs ?? []);
  const stackTargetCards = new Set(stackTargets.map((target) => target.cardId));
  const stackTargetSeats = new Set(stackTargets.filter((target) => !target.cardId).map((target) => target.seat));
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
  const individualCards = new Set(stackTargetCards);
  const cardActions = new Map<string, ForgeChoice[]>();
  for (const choice of choices) {
    if (!choice.cardId || !pieces.has(choice.cardId)) continue;
    if (choice.kind !== "ability") individualCards.add(choice.cardId);
    const actions = cardActions.get(choice.cardId) ?? [];
    actions.push(choice);
    cardActions.set(choice.cardId, actions);
  }
  for (const card of battlefield) {
    if (card.attachedTo) individualCards.add(card.attachedTo);
  }
  const actionKey = (card: ForgeCard) => JSON.stringify(cardActions.get(card.id)?.map(
    ({ label, manaAbility }) => [label, !!manaAbility],
  ) ?? []);
  const groupsFor = (seat: ForgeSeat) => groupBattlefieldCards(players[seat].battlefield, individualCards)
    .flatMap((group) => group.every((card) => actionKey(card) === actionKey(group[0]))
      ? [group]
      : group.map((card) => [card]));
  const battlefieldGroups = { player: groupsFor("player"), opponent: groupsFor("opponent") };
  const inspectedStack = openStack?.revision === state.revision
    ? [...battlefieldGroups.player, ...battlefieldGroups.opponent].find(
      (group) => group.length > 1 && group.some((card) => card.id === openStack.id),
    )
    : undefined;
  const blockChoices = choices.flatMap(choice => choice.kind === "block" && choice.cardId && choice.block
    ? [{ choice, blockerId: choice.cardId, ...choice.block }]
    : []);
  const blockers = new Set(blockChoices.map(choice => choice.blockerId));
  const selectedBlocker = blockSelection?.revision === state.revision && blockers.has(blockSelection.id)
    ? pieces.get(blockSelection.id)
    : undefined;
  const selectedBlocks = selectedBlocker ? blockChoices.filter(choice => choice.blockerId === selectedBlocker.id) : [];
  const blockTargets = new Map(selectedBlocks.map(choice => [choice.attackerId, choice]));

  const assignments = battlefield.flatMap(card => (card.blockingIds ?? [])
    .filter(attackerId => pieces.has(attackerId))
    .map(attackerId => ({ blockerId: card.id, attackerId })));
  const attackersByName = new Map<string, string[]>();
  for (const card of battlefield) {
    if (!card.attacking) continue;
    const name = card.faceDown ? "Face-down card" : card.name;
    attackersByName.set(name, [...(attackersByName.get(name) ?? []), card.id]);
  }
  const attackNumbers = new Map<string, number>();
  for (const ids of attackersByName.values()) {
    if (ids.length > 1) ids.forEach((id, index) => attackNumbers.set(id, index + 1));
  }
  const attackName = (id: string) => {
    const card = pieces.get(id);
    if (!card) return "attacker";
    const name = card.faceDown ? "Face-down card" : card.name;
    const number = attackNumbers.get(id);
    return number === undefined ? name : `${name} ${number}`;
  };
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
  // A pass choice distinguishes regular priority from a play offered by a resolving effect.
  const hasPriority = choices.some((choice) => choice.kind === "pass");
  const cardPlayIds = new Set(hasPriority
    ? choices.filter((choice) => choice.kind === "card").map((choice) => choice.cardId)
    : []);
  const playableExile = opening ? [] : seatOrder.flatMap((seat) =>
    (players[seat].exile ?? []).filter((card) => cardPlayIds.has(card.id)),
  );
  const visibleCards = new Set(
    [
      ...hand,
      ...stack,
      ...pileCards,
      ...playableExile,
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
  const choosingAbility = menuChoices.every(
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
      !locked && !selectedBlocker &&
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
  }, [state.revision, locked, selectedBlocker]);

  useEffect(() => {
    setCardFilter("");
  }, [searchId]);

  useEffect(() => {
    const button = firstBlockTarget.current;
    if (!selectedBlocker || !button || button.disabled) return;
    button.dataset.autoFocus = "";
    button.focus({ preventScroll: true });
    delete button.dataset.autoFocus;
  }, [selectedBlocker?.id, state.revision, locked]);

  function choose(choice: ForgeChoice) {
    setMenuCard(null);
    setPile(null);
    setOpenStack(null);
    // When undoing a block, keep that creature selected for its next legal assignment.
    setBlockSelection(choice.block?.remove && choice.cardId
      ? { id: choice.cardId, revision: state.revision + 1 }
      : null);
    setShowBlockList(false);
    onChoose(choice.id);
  }

  function option(choice: ForgeChoice, focusRef?: Ref<HTMLButtonElement>) {
    if (choice.kind === "pass") {
      const ending = state.phase === "Ending phase";
      const endTurn = (!state.priorityStop.own.length || ending) && choice.endTurnId;
      const passTurn = choice.passTurnId;
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
          {passTurn && (
            <Button variant="outline" disabled={locked} onClick={() => onChoose(passTurn)}>
              Pass Turn
            </Button>
          )}
        </Fragment>
      );
    }
    return (
      <Button
        key={choice.id}
        ref={focusRef}
        className={!locked && choice.kind === "target" ? "pt-legal-target" : undefined}
        variant={choice.kind === "target" ? "outline" : undefined}
        disabled={locked}
        onClick={() => choose(choice)}
      >
        {choice.label}
      </Button>
    );
  }

  function tile(card: ForgeCard, { copyNumber, besideHand = false }: {
    copyNumber?: number;
    besideHand?: boolean;
  } = {}) {
    const name = card.faceDown ? "Face-down card" : card.name;
    const actions = choices.filter((choice) => choice.cardId === card.id);
    const blockTarget = blockTargets.get(card.id);
    const canSelectBlocker = blockers.has(card.id);
    const removableBlocks = actions.filter((choice) => choice.kind === "block" && choice.block?.remove);
    const selected = selectedBlocker?.id === card.id;
    const mark = targetMark(legalCards.has(card.id) || !!blockTarget && !locked, stackTargetCards.has(card.id));
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
    const combatLabel = card.blockingIds?.length
      ? `Blocking ${card.blockingIds.map(attackName).join(", ")}`
      : card.blocking && card.target ? `Blocking ${card.target}` : combat;
    const attached = attachments.get(card.id) ?? [];
    const attachedTo = card.attachedTo ? pieces.get(card.attachedTo)?.name
      : card.attachedToPlayer && seatNames[card.attachedToPlayer];
    const description = [
      card.attacking ? attackName(card.id) : name, card.token && "Token", stats, card.tapped && "Tapped", combatLabel,
      attachedTo && `Attached to ${attachedTo}`, ...attached,
    ]
      .filter(Boolean)
      .join(", ");
    let actionLabel = actions.length > 1
      ? `Choose ${abilityCount === actions.length ? "an ability" : "action"} for ${name}`
      : move?.label;
    if (canSelectBlocker) actionLabel = `Select ${name} to block`;
    if (blockTarget && selectedBlocker) {
      const attacker = attackName(card.id);
      actionLabel = blockTarget.remove
        ? `Remove block on ${attacker} by ${selectedBlocker.name}`
        : `${blockTarget.reassign ? "Move block to" : "Block"} ${attacker} with ${selectedBlocker.name}`;
    }
    const attachmentLabels = [
      ...(attachedTo ? [`Attached to ${attachedTo}`] : []),
      ...(attached.length ? [`Attachments · ${attached.join(", ")}`] : []),
    ];
    const label = actionLabel
      ? [actionLabel, card.token && "Token", canSelectBlocker && combatLabel, ...attachmentLabels].filter(Boolean).join(", ")
      : description;
    function selectBlocker() {
      setBlockSelection(selected ? null : { id: card.id, revision: state.revision });
      setShowBlockList(false);
    }
    function removeBlock() {
      if (removableBlocks.length === 1) {
        choose(removableBlocks[0]);
      } else {
        setBlockSelection({ id: card.id, revision: state.revision });
        setShowBlockList(true);
      }
    }
    return (
      <TableCard
        key={card.id}
        name={name}
        combatId={card.attacking || card.blockingIds?.length ? card.id : undefined}
        attackerNumber={attackNumbers.get(card.id)}
        label={[label, ...mark.labels, ...statuses.map(s => s.label),
          ...(copyNumber === undefined ? [] : [`Copy ${copyNumber}`])].join(", ")}
        className={selected ? `${mark.className} pt-blocker-selected` : mark.className}
        statuses={statuses}
        tapped={card.tapped}
        opensDialog={!canSelectBlocker && actions.length > 1}
        pressed={canSelectBlocker ? selected : undefined}
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
        focusRef={copyNumber === undefined && (!besideHand || !pile) ? (
          selectedBlocks[0]?.attackerId === card.id ? firstBlockTarget :
            actions.some((c) => c.id === initialChoice) ? firstButton : undefined
        ) : undefined}
        onDoubleClick={!locked && removableBlocks.length ? removeBlock : undefined}
        onClick={
          blockTarget ? () => choose(blockTarget.choice)
            : canSelectBlocker ? selectBlocker
            : move
            ? () => {
              if (actions.length === 1) choose(move);
              else {
                setOpenStack(null);
                setMenuCard(card);
              }
            }
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

  function groupTile(group: ForgeCard[]) {
    const card = group.find((member) => cardActions.get(member.id)?.some((choice) => choice.id === initialChoice))
      ?? group[0];
    if (group.length === 1) return tile(card);
    const layers = Math.min(group.length - 1, 2);
    const countLabel = `View ${group.length} ${card.tapped ? "tapped " : ""}copies of ${card.name}`;
    return (
      <div key={group[0].id} className="pt-permanent-stack" data-depth={layers} data-tapped={card.tapped}>
        {Array.from({ length: layers }, (_, index) => (
          <div key={index} className={`pt-piece pt-permanent-stack-layer${card.tapped ? " is-tapped" : ""}`} inert>
            <ForgeArt card={card} />
          </div>
        ))}
        {tile(card)}
        <button type="button" className="pt-permanent-stack-count"
          aria-label={countLabel} data-hint={countLabel}
          aria-haspopup="dialog" onClick={() => setOpenStack({ id: card.id, revision: state.revision })}>
          ×{group.length}
        </button>
      </div>
    );
  }

  function renderDamageRecipient(recipient: ForgeDamageRecipient, name: string) {
    const card = recipient.cardId ? pieces.get(recipient.cardId) : undefined;
    if (!card) {
      return (
        <div className="pt-damage-defender">
          <UserRound size={32} aria-hidden />
          <strong>{name}</strong>
          {recipient.seat && <LifeValue life={players[recipient.seat].life} />}
        </div>
      );
    }
    const stats = card.power != null && card.toughness != null ? `${card.power}/${card.toughness}` : undefined;
    const statuses = cardStatuses(card);
    return (
      <TableCard name={name} label={[name, stats, ...statuses.map((status) => status.label)].filter(Boolean).join(", ")}
        art={<ForgeArt card={card} />} reading={<ForgeArt card={card} inspect />}
        statuses={statuses} flags={stats && <span>{stats}</span>} />
    );
  }

  function renderSeat(seat: ForgeSeat) {
    const own = seat === viewer;
    const data = players[seat];
    const targets = choices.filter(
      (choice) => isLifeTarget(choice) && choice.seat === seat,
    );
    const lifeMark = targetMark(!locked && targets.length > 0, stackTargetSeats.has(seat));
    const libraryTop = data.libraryTop;
    const libraryMark = targetMark(!!libraryTop && legalCards.has(libraryTop.id),
      !!libraryTop && stackTargetCards.has(libraryTop.id));
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
                className={libraryMark.className}
                label={[`${seatNames[seat]}'s library, ${data.libraryCount} cards${libraryTop ? " · View top card" : ""}`, ...libraryMark.labels].join(" · ")}
                open={pile?.seat === seat && pile.zone === "library"}
                onOpen={libraryTop ? () => setPile({ seat, zone: "library" }) : undefined}
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
              const mark = targetMark(cards.some((card) => legalCards.has(card.id)),
                cards.some((card) => stackTargetCards.has(card.id)));
              return (
                <ZoneCounter
                  key={zone}
                  zone={zone}
                  count={cards.length}
                  open={pile?.seat === seat && pile.zone === zone}
                  className={mark.className}
                  label={[`${seatNames[seat]}'s ${zone}, ${cards.length} ${cards.length === 1 ? "card" : "cards"}`, ...mark.labels].join(" · ")}
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
                    className={lifeMark.className}
                    aria-label={[choice.label, ...lifeMark.labels].join(", ")}
                    ref={focusFor(choice)}
                    disabled={locked}
                    onClick={() => choose(choice)}
                  >
                    <Target size={14} aria-hidden />
                    {choice.label} · {life}
                  </button>
                ))
              ) : (
                <div className={`ptc-life ${lifeMark.className}`}>
                  {life}
                  {lifeMark.labels.length > 0 && <span className="sr-only">{lifeMark.labels.join(", ")}</span>}
                </div>
              )}
              <ManaPool playerName={seatNames[seat]} amounts={data.manaByColor} total={data.mana} />
            </div>
          </div>
        }
        cards={battlefieldGroups[seat].map((group) => ({
          group: battlefieldGroup(group[0]),
          tile: groupTile(group),
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
      stackTargets={stack.some((card) => legalCards.has(card.id))}
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
          {selectedBlocker && (
            <Button variant="outline" disabled={locked} aria-haspopup="dialog" onClick={() => setShowBlockList(true)}>
              Choose from list
            </Button>
          )}
          <div className="pt-forge-options pt-turn-actions">
            {damageAssignment && !showDamageAssignment && (
              <Button type="button" variant="outline" aria-haspopup="dialog" onClick={() => setDismissedDamage(undefined)}>
                Assign damage
              </Button>
            )}
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
                hand={hand.map((card) => tile(card))}
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
      arenaOverlay={assignments.length > 0 ? <CombatLinks assignments={assignments} /> : undefined}
      handLabel={handLabel}
      handCount={players[handSeat].handCount}
      playableExile={playableExile.map((card) => tile(card, { besideHand: true }))}
      hand={
        opening
          ? [
              <span key="opening" className="pt-empty">
                Review your opening hand
              </span>,
            ]
          : hand.map((card) => tile(card))
      }
      stack={
        <StackPanel count={stack.length}>
          {stack.length > 0 && (
            <ol className="ptc-stack-list">
              {stack.map((card, index) => {
                const actions = choices.filter(
                  (choice) => choice.cardId === card.id,
                );
                const mark = targetMark(legalCards.has(card.id), stackTargetCards.has(card.id));
                return (
                  <li key={card.id} className={`ptc-stack-entry ${mark.className}`}>
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
                    {mark.labels.length > 0 && <span className="sr-only">{mark.labels.join(", ")}</span>}
                    {card.description && <small>{card.description}</small>}
                    {card.target && <small className={card.targetRefs?.length ? "pt-stack-target-line" : undefined}>Targeting {card.target}</small>}
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
        <TableDialog title={state.prompt} reportable={false} className="pt-mana-dialog">
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
              ? `Choose an ability for ${menuCard.name}`
              : `Actions for ${menuCard.name}`
          }
          className="pt-card-action-dialog"
          reportable={false}
          closeLabel="Close action choices"
          onClose={() => setMenuCard(null)}
        >
          <div className="pt-card-action-options">
            {menuChoices.map((choice) => (
              <button
                type="button"
                key={choice.id}
                disabled={locked}
                className="pt-card-action-option"
                aria-label={choice.label}
                onClick={() => choose(choice)}
              >
                <CardActionLabel choice={choice} />
              </button>
            ))}
          </div>
        </TableDialog>
      )}
      {selectedBlocker && showBlockList && (
        <TableDialog title={`Block with ${selectedBlocker.name}`} reportable={false}
          onClose={() => setShowBlockList(false)}>
          <div className="pt-combat-options">
            {selectedBlocks.map(({ choice, attackerId, remove, reassign }) => (
              <Button key={choice.id} variant="outline" disabled={locked} onClick={() => choose(choice)}>
                {remove ? "Remove block on " : reassign ? "Move block to " : "Block "}{attackName(attackerId)}
              </Button>
            ))}
          </div>
        </TableDialog>
      )}
      {inspectedStack && (
        <TableDialog title={inspectedStack[0].name} reportable={false}
          closeLabel="Close grouped cards" onClose={() => setOpenStack(null)}>
          <div className="pt-field">
            {inspectedStack.map((card, index) => tile(card, { copyNumber: index + 1 }))}
          </div>
        </TableDialog>
      )}
      {pile && (
        <TableDialog
          title={pile.zone === "library" ? `Top of ${seatNames[pile.seat]}’s library` : `${seatNames[pile.seat]}’s ${pile.zone}`}
          reportable={false}
          closeLabel="Close zone"
          onClose={() => setPile(null)}
        >
          {pileCards.length ? (
            <div className="pt-field">{pileCards.map((card) => tile(card))}</div>
          ) : (
            <p className="pt-subtle">This zone is empty.</p>
          )}
        </TableDialog>
      )}
      {librarySearch && showSearch && (
        <TableDialog
          title={librarySearch.title}
          label={libraryOperation}
          reportable={false}
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
            <div className="pt-field">{searchCards.map((card) => tile(card))}</div>
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
      {damageAssignment && (
        <CombatDamageDialog
          key={damageAssignment.choiceId}
          assignment={damageAssignment}
          sourceName={pieces.has(damageAssignment.sourceCardId) ? attackName(damageAssignment.sourceCardId) : damageAssignment.sourceName}
          open={showDamageAssignment}
          locked={locked}
          error={matchTools.decisionError}
          onClose={() => setDismissedDamage(damageAssignment.choiceId)}
          onChoose={onChoose}
          recipientName={(recipient) => recipient.seat ? seatNames[recipient.seat] : recipient.label}
          renderRecipient={renderDamageRecipient}
        />
      )}
    </TableBoard>
  );
}
