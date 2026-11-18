import { useEffect, useRef, useState, type Ref } from "react";
import { Droplet, ImageOff, RotateCcw, Target, X } from "lucide-react";
import CardImage from "@/components/CardImage";
import { Button } from "@/components/ui/button";
import { database } from "@/services/database";
import { LifeValue, StackPanel, TableBoard, TableSeat } from "./TableBoard";
import { TableCard } from "./TableCards";
import type {
  ForgeCard,
  ForgeChoice,
  ForgeMatch,
  ForgeSeat,
  Scenario,
} from "./forge-match";

type Artwork = { id: string; name: string };
type ArtCache = Map<string, Promise<Artwork | undefined>>;

function ForgeArt({
  card,
  imageCacheDir,
  cache,
}: {
  card: ForgeCard;
  imageCacheDir: string;
  cache: ArtCache;
}) {
  const { name, setCode = "", collectorNumber = "" } = card;
  const [art, setArt] = useState<Artwork>();
  useEffect(() => {
    const key = JSON.stringify([name, setCode, collectorNumber]);
    let request = cache.get(key);
    if (!request) {
      request = database()
        .then(async (db) => {
          const [row] = await db.select<Artwork[]>(
            `SELECT id, name FROM cards
           WHERE (name = ? COLLATE NOCASE OR (set_code = ? COLLATE NOCASE AND collector_number = ?))
             AND image_uri IS NOT NULL
           ORDER BY (set_code = ? COLLATE NOCASE) DESC, (collector_number = ?) DESC,
             (name = ? COLLATE NOCASE) DESC, set_code, collector_number, id LIMIT 1`,
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
  }, [cache, name, setCode, collectorNumber]);
  if (art) return <CardImage card={art} imageCacheDir={imageCacheDir} />;
  return (
    <div className="card-image">
      <div className="card-image-placeholder">
        <ImageOff size={20} aria-hidden />
        <span>{name}</span>
      </div>
    </div>
  );
}

const seatOrder: ForgeSeat[] = ["opponent", "player"];

export default function ForgeBoard({
  state,
  scenario,
  locked,
  onChoose,
  replay,
  imageCacheDir,
}: {
  state: ForgeMatch;
  scenario: Scenario;
  locked: boolean;
  onChoose: (id: string) => void;
  replay: () => void;
  imageCacheDir: string;
}) {
  const [graveyard, setGraveyard] = useState<ForgeSeat | null>(null);
  const [menuCard, setMenuCard] = useState<ForgeCard | null>(null);
  const firstButton = useRef<HTMLButtonElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const cache = useRef<ArtCache>(new Map());
  const { actor, players, stack, choices } = state;
  const handSeat =
    actor === "opponent" && scenario === "response" ? "opponent" : "player";
  const hand = players[handSeat].hand;
  const handLabel = handSeat === "player" ? "Your hand" : "Opponent's hand";
  const pileCards = graveyard ? players[graveyard].graveyard : [];
  const visibleCards = new Set(
    [
      ...hand,
      ...stack,
      ...pileCards,
      ...players.player.battlefield,
      ...players.opponent.battlefield,
    ].map((card) => card.id),
  );
  const isLifeTarget = (choice: ForgeChoice) =>
    choice.kind === "target" && !!choice.seat && !choice.cardId;
  const toolbar = choices.filter(
    (choice) =>
      !isLifeTarget(choice) &&
      (!choice.cardId || !visibleCards.has(choice.cardId)),
  );
  const menuChoices = menuCard
    ? choices.filter((choice) => choice.cardId === menuCard.id)
    : [];
  const initialChoice = choices[0]?.id;
  const focusFor = (choice?: ForgeChoice) =>
    choice && choice.id === initialChoice ? firstButton : undefined;

  useEffect(() => {
    if (!locked && !menuCard)
      firstButton.current?.focus({ preventScroll: true });
    if (menuCard) menuButton.current?.focus();
  }, [state, locked, menuCard]);

  function choose(choice: ForgeChoice) {
    setMenuCard(null);
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
    const actions = choices.filter((choice) => choice.cardId === card.id);
    const move = actions[0];
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
    const description = [card.name, stats, card.tapped && "Tapped", combatLabel]
      .filter(Boolean)
      .join(", ");
    const label =
      actions.length > 1
        ? `Choose action for ${card.name}`
        : (move?.label ?? description);
    return (
      <TableCard
        key={card.id}
        name={card.name}
        label={label}
        tapped={card.tapped}
        flags={
          <>
            {combat && <span>{combat}</span>}
            {stats && <span>{stats}</span>}
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
    const own = seat === "player";
    const data = players[seat];
    const targets = choices.filter(
      (choice) => isLifeTarget(choice) && choice.seat === seat,
    );
    const life = <LifeValue life={data.life} />;
    const pileLabel = own ? "Your graveyard" : "Opponent's graveyard";
    return (
      <TableSeat
        key={seat}
        own={own}
        label={own ? "Player 1" : "Player 2"}
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
            <button
              type="button"
              aria-expanded={graveyard === seat}
              aria-label={`${pileLabel}, ${data.graveyard.length} ${data.graveyard.length === 1 ? "card" : "cards"}`}
              onClick={() => setGraveyard(graveyard === seat ? null : seat)}
            >
              Graveyard <b>{data.graveyard.length}</b>
            </button>
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
          <div className="ptc ptc-turn" aria-label="Turn and phase">
            {state.turn > 0 && (
              <span className="ptc-turn-number">
                Turn <strong>{state.turn}</strong>
              </span>
            )}
            <span className="ptc-turn-player">
              {state.phase}
              <small>
                {state.active === "opponent" ? "Opponent's turn" : "Your turn"}
              </small>
            </span>
          </div>
          <div className="pt-forge-prompt">
            <strong>{actor === "opponent" ? "Opponent" : "You"}</strong>
            <span role="status">{state.prompt}</span>
          </div>
          <div className="pt-forge-options">
            {toolbar.map((choice) => option(choice, focusFor(choice)))}
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
      hand={hand.map(tile)}
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
                    <strong>{card.name}</strong>
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
        <section
          className="pt-pile-panel"
          aria-label={`Actions for ${menuCard.name}`}
        >
          <header className="pt-pile-heading">
            <h3>{menuCard.name}</h3>
            <button
              type="button"
              className="pt-btn"
              onClick={() => setMenuCard(null)}
            >
              <X size={14} /> Close
            </button>
          </header>
          <div className="pt-forge-options">
            {menuChoices.map((choice, index) =>
              option(choice, index === 0 ? menuButton : undefined),
            )}
          </div>
        </section>
      )}
      {graveyard && (
        <section
          className="pt-pile-panel"
          aria-label={
            graveyard === "player" ? "Your graveyard" : "Opponent's graveyard"
          }
        >
          <header className="pt-pile-heading">
            <div>
              <small>{graveyard === "player" ? "Player 1" : "Player 2"}</small>
              <h3>
                Graveyard <small>{pileCards.length}</small>
              </h3>
            </div>
            <button
              type="button"
              className="pt-btn"
              onClick={() => setGraveyard(null)}
            >
              Close zone
            </button>
          </header>
          {pileCards.length ? (
            <div className="pt-field">{pileCards.map(tile)}</div>
          ) : (
            <p className="pt-subtle">This zone is empty.</p>
          )}
        </section>
      )}
    </TableBoard>
  );
}
