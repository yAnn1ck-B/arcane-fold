import { useEffect, useId, useRef, useState, type Ref } from "react";
import {
  Droplet,
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
} from "./TableBoard";
import { TableCard } from "./TableCards";
import { CardReading, StackCardName } from "./CardPreview";
import { TableDialog } from "./TableDialog";
import type {
  ForgeCard,
  ForgeChoice,
  ForgeMatch,
  ForgeSeat,
  Scenario,
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
const pileNames = { graveyard: "Graveyard", exile: "Exile" } as const;
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
  const selected = choices.find((choice) => choice.label.toLowerCase() === query);
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

function ForgeArt({
  card,
  imageCacheDir,
  cache,
  inspect = false,
}: {
  card: ForgeCard;
  imageCacheDir: string;
  cache: ArtCache;
  inspect?: boolean;
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
      name={name}
      art={image}
      manaCost={art?.manaCost || card.manaCost}
      typeLine={card.typeLine || art?.typeLine}
      oracleText={art?.oracleText || card.oracleText}
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
  scenario,
  locked,
  onChoose,
  replay,
  imageCacheDir,
  viewer,
  handHidden,
  onSwitch,
}: {
  state: ForgeMatch;
  scenario: Scenario;
  locked: boolean;
  onChoose: (id: string) => void;
  replay: () => void;
  imageCacheDir: string;
  viewer: ForgeSeat;
  handHidden: boolean;
  onSwitch?: () => void;
}) {
  const [pile, setPile] = useState<Pile | null>(null);
  const [menuCard, setMenuCard] = useState<ForgeCard | null>(null);
  const [deferredSearch, setDeferredSearch] = useState<string>();
  const [cardFilter, setCardFilter] = useState("");
  const firstButton = useRef<HTMLButtonElement>(null);
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
  const handLabel = sharedSeats
    ? `Player ${viewer === "player" ? 1 : 2} hand`
    : "Your hand";
  const pileCards = pile ? (players[pile.seat][pile.zone] ?? []) : [];
  const visibleCards = new Set(
    [
      ...hand,
      ...stack,
      ...pileCards,
      ...(librarySearch?.cards ?? []),
      ...players.player.battlefield,
      ...players.opponent.battlefield,
    ].map((card) => card.id),
  );
  const isLifeTarget = (choice: ForgeChoice) =>
    choice.kind === "target" && !!choice.seat && !choice.cardId;
  const typeChoices = choices.filter((choice) => choice.kind === "type");
  const toolbar = librarySearch
    ? []
    : choices.filter(
        (choice) =>
          choice.kind !== "type" &&
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
    if (!locked && button && !document.querySelector("dialog[open]")) {
      // Advance keyboard focus without opening a card reading over a new decision.
      button.dataset.autoFocus = "";
      button.focus({ preventScroll: true });
      delete button.dataset.autoFocus;
    }
  }, [state, locked]);

  useEffect(() => {
    setCardFilter("");
  }, [searchId]);

  function choose(choice: ForgeChoice) {
    setMenuCard(null);
    setPile(null);
    onChoose(choice.id);
  }

  function option(choice: ForgeChoice, focusRef?: Ref<HTMLButtonElement>) {
    return (
      <Button
        key={choice.id}
        ref={focusRef}
        disabled={locked}
        variant={choice.kind === "pass" ? "outline" : "default"}
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
    const description = [name, stats, card.tapped && "Tapped", combatLabel]
      .filter(Boolean)
      .join(", ");
    const label =
      actions.length > 1
        ? `Choose ${abilityCount === actions.length ? "an ability" : "action"} for ${name}`
        : (move?.label ?? description);
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
          />
        }
        flags={
          <>
            {combat && <span>{combat}</span>}
            {stats && <span>{stats}</span>}
            {card.chosenType && <span>Chosen type · {card.chosenType}</span>}
            {abilityCount > 1 && <span>{abilityCount} abilities</span>}
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
        label={seat === "player" ? "Player 1" : "Player 2"}
        title={own ? "You" : "Opponent"}
        piles={
          <>
            {data.libraryCount != null && (
              <span className="pt-zone-count">
                Library <b>{data.libraryCount}</b>
              </span>
            )}
            {!own && (
              <span className="pt-zone-count">
                Hand <b>{data.handCount}</b>
              </span>
            )}
            {(["graveyard", "exile"] as const).map((zone) => {
              const cards = data[zone];
              if (!cards) return null;
              return (
                <button
                  key={zone}
                  type="button"
                  aria-haspopup="dialog"
                  aria-expanded={pile?.seat === seat && pile.zone === zone}
                  aria-label={`${pileLabel(seat, viewer, zone)}, ${cards.length} ${cards.length === 1 ? "card" : "cards"}`}
                  onClick={() => setPile({ seat, zone })}
                >
                  {pileNames[zone]} <b>{cards.length}</b>
                </button>
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
              <span className="pt-subtle">
                <Droplet size={14} /> Mana pool <b>{data.mana}</b>
              </span>
            </div>
          </div>
        }
        cards={data.battlefield.map(tile)}
      />
    );
  }

  return (
    <TableBoard
      label="Forge playtest table"
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
          <div className="pt-forge-prompt">
            {state.stage === "decision" &&
              !handHidden &&
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
          <div className="pt-forge-options">
            {switchButton(
              !choices.length && state.stage === "decision"
                ? firstButton
                : undefined,
            )}
            {librarySearch && !showSearch && (
              <Button
                variant="outline"
                onClick={() => setDeferredSearch(undefined)}
              >
                View {libraryOperation.toLowerCase()}
              </Button>
            )}
            {toolbar.map((choice) => option(choice, focusFor(choice)))}
            {typeChoices.length > 0 && (
              <TypeChoice
                key={typeChoices[0].id}
                choices={typeChoices}
                locked={locked}
                choose={choose}
              />
            )}
            {state.stage === "finished" && (
              <Button
                ref={firstButton}
                disabled={locked}
                variant="outline"
                onClick={replay}
              >
                <RotateCcw size={15} />{" "}
                {scenario === "deck" ? "Play again" : "Replay trial"}
              </Button>
            )}
          </div>
        </div>
      }
      seats={seatOrder.map(renderSeat)}
      handLabel={handLabel}
      handCount={players[handSeat].handCount}
      hand={
        handHidden
          ? [
              <span key="hidden" className="pt-empty">
                Hand hidden during seat change
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
      {menuCard && menuChoices.length > 0 && (
        <TableDialog
          title={choosingAbility ? "Choose an ability" : `Actions for ${menuCard.name}`}
          subtitle={choosingAbility ? menuCard.name : undefined}
          closeLabel={choosingAbility ? "Cancel ability selection" : "Close"}
          headerAction={switchButton()}
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
          headerAction={switchButton()}
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
          headerAction={switchButton()}
          label={libraryOperation}
          closeLabel={`Close ${libraryOperation.toLowerCase()}`}
          onClose={() => setDeferredSearch(searchId)}
        >
          {state.prompt !== librarySearch.title && (
            <p className="pt-search-prompt">{state.prompt}</p>
          )}
          {libraryOperation === "Library search" && librarySearch.cards.length > 0 && (
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
