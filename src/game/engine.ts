import type { DeckDetail } from "../lib/types";
import { manaTypes, seats, steps, zones } from "./types";
import type {
  Action,
  Match,
  MatchView,
  Piece,
  Player,
  PlayerView,
  Seat,
  Zone,
} from "./types";

export * from "./types";

function requireThat(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}
const otherSeat = (seat: Seat): Seat => (seat === 0 ? 1 : 0);
const zeroMana = () => ({ W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 });
function newPlayer(name: string): Player {
  return {
    deckName: name,
    life: 20,
    mana: zeroMana(),
    zones: {
      library: [],
      hand: [],
      battlefield: [],
      graveyard: [],
      exile: [],
      command: [],
    },
    kept: false,
    mulligans: 0,
  };
}
function newPiece(
  id: string,
  seat: Seat,
  printing: string | null,
  tokenName: string | null,
): Piece {
  return {
    id,
    printing,
    tokenName,
    owner: seat,
    controller: seat,
    tapped: false,
    back: false,
    faceDown: false,
    revealed: false,
    counters: {},
    attachedTo: null,
    combat: null,
  };
}

/** Return the actual private shuffle outcome so replay never consults a random generator. */
export function randomOrder(ids: readonly string[]): string[] {
  const order = [...ids];
  const sample = new Uint32Array(1);
  for (let i = order.length - 1; i > 0; i--) {
    const limit = 0x100000000 - (0x100000000 % (i + 1));
    do {
      crypto.getRandomValues(sample);
    } while (sample[0] >= limit);
    const j = sample[0] % (i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

export function createMatch(
  decks: [DeckDetail, DeckDetail],
  first: Seat = 0,
): Match {
  const state: Match = {
    version: 1,
    players: [newPlayer(decks[0].name), newPlayer(decks[1].name)],
    catalog: {},
    pieces: {},
    stack: [],
    turn: 1,
    active: first,
    step: 0,
    nextId: 1,
  };
  for (const seat of seats) {
    const piles = state.players[seat].zones;
    for (const entry of decks[seat].cards) {
      if (entry.section !== "main") continue;
      requireThat(
        Number.isSafeInteger(entry.quantity) && entry.quantity >= 0,
        "Invalid deck quantity.",
      );
      state.catalog[entry.card.id] ??= structuredClone(entry.card);
      for (let i = 0; i < entry.quantity; i++) {
        const id = crypto.randomUUID();
        state.pieces[id] = newPiece(id, seat, entry.card.id, null);
        piles.library.push(id);
      }
    }
    requireThat(
      seat === 1 || piles.library.length,
      "Choose a deck with at least one main-deck card.",
    );
    piles.library = randomOrder(piles.library);
    piles.hand = piles.library.splice(0, 7);
  }
  return state;
}

/** Build the only state a seat's table should render. Library inspection is an explicit
 * local permission for the viewing seat. A fixed set retains the original look at N. */
export function projectMatch(
  match: Match,
  viewer: Seat,
  look: number | ReadonlySet<string> = 0,
): MatchView {
  const catalog: Match["catalog"] = {};
  const pieces: Match["pieces"] = {};
  function include(id: string) {
    const card = match.pieces[id];
    const concealed =
      card.faceDown &&
      !card.revealed &&
      !(card.faceDownVisibleTo?.includes(viewer) ?? card.controller === viewer);
    pieces[id] = {
      ...card,
      printing: concealed ? null : card.printing,
      tokenName: concealed ? null : card.tokenName,
      back: concealed ? false : card.back,
      counters: { ...card.counters },
    };
    if (concealed) {
      delete pieces[id].chosenType;
      delete pieces[id].power;
      delete pieces[id].toughness;
    }
    if (pieces[id].printing)
      catalog[pieces[id].printing!] = {
        ...match.catalog[pieces[id].printing!],
        owned: 0,
        oracleOwned: undefined,
      };
  }
  function viewFor(seat: Seat): PlayerView {
    const player = match.players[seat];
    const visible: PlayerView = {
      ...newPlayer(player.deckName),
      life: player.life,
      counters: player.counters,
      kept: player.kept,
      mulligans: player.mulligans,
      openingBottom: viewer === seat ? player.openingBottom : undefined,
      mana: { ...player.mana },
      counts: {
        library: 0,
        hand: 0,
        battlefield: 0,
        graveyard: 0,
        exile: 0,
        command: 0,
      },
    };
    for (const zone of zones) {
      const pile = player.zones[zone] ?? [];
      visible.counts[zone] = pile.length;
      visible.zones[zone] = pile.filter((id, index) => {
        if (match.pieces[id].revealed) return true;
        if (zone === "library")
          return (
            seat === viewer &&
            (typeof look === "number" ? index < look : look.has(id))
          );
        return zone !== "hand" || seat === viewer;
      });
      visible.zones[zone].forEach(include);
    }
    return visible;
  }
  const players: [PlayerView, PlayerView] = [viewFor(0), viewFor(1)];
  for (const item of match.stack) if (item.card) include(item.card);
  const stack = match.stack.map((item) => {
    const hiddenSpell =
      item.card && !pieces[item.card].printing && !pieces[item.card].tokenName;
    const hiddenCopy = item.copyFaceDown;
    if (item.copyPrinting && !hiddenCopy)
      catalog[item.copyPrinting] = {
        ...match.catalog[item.copyPrinting],
        owned: 0,
        oracleOwned: undefined,
      };
    return {
      ...item,
      source: item.source && pieces[item.source] ? item.source : null,
      copyPrinting: hiddenCopy ? null : item.copyPrinting,
      label: hiddenSpell || hiddenCopy ? "Face-down spell" : item.label,
      description: hiddenSpell || hiddenCopy ? undefined : item.description,
    };
  });
  return {
    version: 1,
    viewer,
    players,
    catalog,
    pieces,
    stack,
    active: match.active,
    step: match.step,
    firstStrikeDamage: match.firstStrikeDamage,
    handoffDecision:
      match.handoffDecision?.seat === viewer
        ? match.handoffDecision
        : undefined,
    turn: match.turn,
  };
}

export function prepareShuffle(
  match: Match,
  seat: Seat,
  mulligan = false,
): Action {
  const { library, hand } = match.players[seat].zones;
  return {
    type: mulligan ? "mulligan" : "shuffle",
    seat,
    order: randomOrder(mulligan ? [...library, ...hand] : library),
  };
}
function verifyOrder(order: string[], ids: string[]) {
  const pool = new Set(ids);
  requireThat(
    order.length === ids.length && order.every((id) => pool.delete(id)),
    "Shuffle does not match the cards in this pile.",
  );
}
function piece(state: Match, id: string) {
  requireThat(
    Object.hasOwn(state.pieces, id),
    "This card is no longer in the match.",
  );
  return state.pieces[id];
}
export function locate(
  state: Match,
  id: string,
): { seat: Seat; zone: Zone; pile: string[] } | null {
  for (const seat of seats)
    for (const zone of zones) {
      const pile = state.players[seat].zones[zone];
      if (pile?.includes(id)) return { seat, zone, pile };
    }
  return null;
}
function battlefieldPiece(state: Match, id: string) {
  requireThat(
    locate(state, id)?.zone === "battlefield",
    "Choose a card on the battlefield.",
  );
  return piece(state, id);
}
function detach(state: Match, id: string) {
  for (const card of Object.values(state.pieces))
    if (card.attachedTo === id) card.attachedTo = null;
}
function put(state: Match, card: Piece, zone: Zone, bottom = false) {
  if (card.tokenName !== null && zone !== "battlefield" && zone !== "command") {
    delete state.pieces[card.id];
    return;
  }
  const seat = zone === "battlefield" ? card.controller : card.owner;
  const pile = (state.players[seat].zones[zone] ??= []);
  if (bottom) pile.push(card.id);
  else pile.unshift(card.id);
}
function move(state: Match, id: string, zone: Zone, bottom: boolean) {
  requireThat(zones.includes(zone), "Unknown destination.");
  const card = piece(state, id);
  const location = locate(state, id);
  requireThat(location, "Use the stack controls for a spell on the stack.");
  location.pile.splice(location.pile.indexOf(id), 1);
  if (location.zone !== zone) {
    detach(state, id);
    state.pieces[id] = newPiece(id, card.owner, card.printing, card.tokenName);
  }
  if (zone === "library") state.pieces[id].revealed = false;
  put(state, state.pieces[id], zone, bottom);
}
function entry(state: Match, id: string) {
  const value = state.stack.find((item) => item.id === id);
  requireThat(value, "This entry is no longer on the stack.");
  return value;
}
function textValue(value: string, label: string): string {
  const trimmed = value.trim();
  requireThat(
    trimmed.length > 0 && trimmed.length <= 200,
    label + " must be between 1 and 200 characters.",
  );
  return trimmed;
}
function amount(value: number) {
  requireThat(Number.isSafeInteger(value), "Enter a whole number.");
  return value;
}
function nextTurn(state: Match) {
  delete state.firstStrikeDamage;
  state.turn++;
  state.step = 0;
  state.active = otherSeat(state.active);
  for (const card of Object.values(state.pieces)) {
    card.combat = null;
    delete card.combatTargets;
    delete card.damage;
    if (card.controller === state.active) delete card.summoningSick;
  }
}
export function cleanName(card: Piece, state: Match) {
  const name = card.tokenName ?? state.catalog[card.printing!].name;
  return name.split(" // ")[card.back ? 1 : 0] ?? name;
}
function token(
  state: Match,
  seat: Seat,
  name: string,
  printing: string | null = null,
) {
  const id = "token-" + state.nextId++;
  const card = newPiece(id, seat, printing, textValue(name, "Token name"));
  state.pieces[id] = card;
  put(state, card, "battlefield");
  return card;
}
export function defaultDestination(
  catalog: Match["catalog"],
  card: Pick<Piece, "printing" | "faceDown" | "back">,
): Zone {
  if (card.faceDown) return "battlefield";
  const type = card.printing
    ? catalog[card.printing].typeLine.split(" // ")[card.back ? 1 : 0] ?? ""
    : "";
  return /\b(Instant|Sorcery)\b/i.test(type) ? "graveyard" : "battlefield";
}
function finishEntry(
  state: Match,
  action: Extract<Action, { type: "resolve" | "counterSpell" }>,
) {
  const item = entry(state, action.entry);
  if (action.type === "resolve")
    requireThat(item === state.stack[0], "Resolve the top stack entry first.");
  state.stack.splice(state.stack.indexOf(item), 1);
  if (item.card) {
    const card = piece(state, item.card);
    const zone =
      action.zone ??
      (action.type === "counterSpell"
        ? "graveyard"
        : defaultDestination(state.catalog, card));
    requireThat(zones.includes(zone), "Unknown destination.");
    if (zone !== "battlefield")
      state.pieces[card.id] = newPiece(
        card.id,
        card.owner,
        card.printing,
        card.tokenName,
      );
    put(state, state.pieces[card.id], zone);
  } else if (item.copyKind === "spell" && action.type === "resolve") {
    const card = newPiece("", item.controller, item.copyPrinting, null);
    card.back = item.copyBack;
    card.faceDown = item.copyFaceDown;
    if (
      (action.zone ?? defaultDestination(state.catalog, card)) === "battlefield"
    ) {
      const name = item.copyFaceDown ? "2/2 creature" : item.label;
      token(state, item.controller, name, item.copyPrinting).back =
        item.copyBack;
    }
  }
}

/** Authoritative match transitions. The input remains valid if any command fails. */
export function applyAction(previous: Match, action: Action): Match {
  // Catalog snapshots are immutable, and are normally much larger than a board position.
  const state: Match = {
    ...structuredClone({ ...previous, catalog: undefined }),
    catalog: previous.catalog,
  };
  const player = "seat" in action ? state.players[action.seat] : undefined;
  switch (action.type) {
    case "finishDecision":
      requireThat(
        state.handoffDecision?.seat === action.seat,
        "This player has no pending decision.",
      );
      delete state.handoffDecision;
      break;
    case "draw": {
      const count = amount(action.count ?? 1);
      requireThat(
        count > 0 && count <= player!.zones.library.length,
        "There are not enough cards in the library.",
      );
      const drawn = player!.zones.library.splice(0, count);
      for (const id of drawn) state.pieces[id].revealed = false;
      player!.zones.hand.push(...drawn);
      break;
    }
    case "shuffle":
    case "mulligan": {
      const piles = player!.zones;
      const redraw = action.type === "mulligan";
      if (redraw) {
        requireThat(
          !player!.kept && player!.mulligans < Math.min(7, piles.hand.length),
          "This hand cannot mulligan again.",
        );
      }
      verifyOrder(
        action.order,
        redraw ? [...piles.library, ...piles.hand] : piles.library,
      );
      piles.library = [...action.order];
      for (const id of piles.library) state.pieces[id].revealed = false;
      if (redraw) {
        delete player!.openingBottom;
        piles.hand = piles.library.splice(0, 7);
        player!.mulligans++;
      }
      break;
    }
    case "keep": {
      const { hand, library } = player!.zones;
      requireThat(
        !player!.kept &&
          action.bottom.length === player!.mulligans &&
          new Set(action.bottom).size === action.bottom.length &&
          action.bottom.every((id) => hand.includes(id)),
        "Select one opening-hand card per mulligan to put on the bottom.",
      );
      player!.zones.hand = hand.filter((id) => !action.bottom.includes(id));
      for (const id of action.bottom) state.pieces[id].revealed = false;
      library.push(...action.bottom);
      player!.kept = true;
      delete player!.openingBottom;
      break;
    }
    case "move":
      move(state, action.id, action.zone, action.position === "bottom");
      break;
    case "tap": {
      const card = battlefieldPiece(state, action.id);
      card.tapped = !card.tapped;
      break;
    }
    case "tapMana": {
      const card = battlefieldPiece(state, action.id);
      requireThat(!card.tapped, "This permanent is already tapped.");
      requireThat(amount(action.count) > 0, "Choose a positive amount of mana.");
      const pool = state.players[card.controller].mana;
      pool[action.mana] = amount(pool[action.mana] + action.count);
      card.tapped = true;
      break;
    }
    case "flip": {
      const card = piece(state, action.id);
      card.back = !card.back;
      break;
    }
    case "faceDown": {
      const card = piece(state, action.id);
      card.faceDown = !card.faceDown;
      card.revealed = false;
      delete card.faceDownVisibleTo;
      break;
    }
    case "reveal": {
      const card = piece(state, action.id);
      card.revealed = !card.revealed;
      break;
    }
    case "control": {
      const card = battlefieldPiece(state, action.id);
      const pile = state.players[card.controller].zones.battlefield;
      pile.splice(pile.indexOf(card.id), 1);
      card.controller = otherSeat(card.controller);
      card.combat = null;
      delete card.combatTargets;
      state.players[card.controller].zones.battlefield.unshift(card.id);
      break;
    }
    case "untapAll":
      for (const id of player!.zones.battlefield)
        state.pieces[id].tapped = false;
      break;
    case "clearMana":
      player!.mana = zeroMana();
      break;
    case "life":
      player!.life = amount(player!.life + amount(action.delta));
      break;
    case "mana": {
      const value = amount(player!.mana[action.mana] + amount(action.delta));
      requireThat(value >= 0, "There is not enough mana in the pool.");
      player!.mana[action.mana] = value;
      break;
    }
    case "combat":
      battlefieldPiece(state, action.id).combat = action.mark;
      delete state.pieces[action.id].combatTargets;
      break;
    case "attach": {
      const card = battlefieldPiece(state, action.id);
      let to = action.to;
      while (to !== null) {
        requireThat(to !== action.id, "Attachments cannot form a loop.");
        to = battlefieldPiece(state, to).attachedTo;
      }
      card.attachedTo = action.to;
      delete card.attachedToPlayer;
      break;
    }
    case "playerCounter":
    case "counter": {
      const counters =
        action.type === "playerCounter"
          ? (state.players[action.seat].counters ??= {})
          : piece(state, action.id).counters;
      const name = textValue(action.name, "Counter name");
      requireThat(
        !Object.hasOwn(Object.prototype, name),
        "Choose a different counter name.",
      );
      const value = amount((counters[name] ?? 0) + amount(action.delta));
      requireThat(value >= 0, "There are not enough counters to remove.");
      if (value === 0) delete counters[name];
      else counters[name] = value;
      break;
    }
    case "token":
      token(state, action.seat, action.name);
      break;
    case "cast":
    case "ability": {
      const card = piece(state, action.id);
      const cast = action.type === "cast";
      if (cast) {
        const location = locate(state, action.id);
        requireThat(location, "This spell is already on the stack.");
        location.pile.splice(location.pile.indexOf(card.id), 1);
        detach(state, card.id);
        const controller = card.controller;
        const back = card.back;
        const faceDown = card.faceDown;
        state.pieces[card.id] = {
          ...newPiece(card.id, card.owner, card.printing, card.tokenName),
          controller,
          back,
          faceDown,
        };
      }
      state.stack.unshift({
        id: "stack-" + state.nextId++,
        kind: cast ? "spell" : "ability",
        controller: card.controller,
        card: cast ? card.id : null,
        source: card.id,
        targets: action.targets?.trim() ?? "",
        label: cast
          ? cleanName(card, state)
          : textValue(action.label, "Ability name"),
        copyPrinting: null,
        copyKind: null,
        copyFaceDown: false,
        copyBack: false,
      });
      break;
    }
    case "copy": {
      const original = entry(state, action.entry);
      const spell = original.card ? state.pieces[original.card] : null;
      const faceDown = spell?.faceDown ?? original.copyFaceDown;
      const copyKind =
        original.kind === "copy" ? original.copyKind : original.kind;
      // Only copy visible characteristics. The hidden card's artwork and name
      // must never be attached to a copy, even for the copy's controller.
      state.stack.unshift({
        ...original,
        id: "stack-" + state.nextId++,
        kind: "copy",
        controller: action.seat,
        card: null,
        label: faceDown ? "Face-down spell" : original.label,
        source: faceDown ? null : original.source,
        targets: action.targets?.trim() ?? original.targets,
        copyKind,
        copyFaceDown: faceDown,
        copyPrinting: faceDown
          ? null
          : spell?.printing ?? original.copyPrinting,
        copyBack: !faceDown && (spell?.back ?? original.copyBack),
      });
      break;
    }
    case "targets":
      entry(state, action.entry).targets = action.targets.trim();
      break;
    case "reorderStack": {
      const current = state.stack.indexOf(entry(state, action.entry));
      const target = current + (action.direction === "up" ? -1 : 1);
      requireThat(
        target >= 0 && target < state.stack.length,
        "This entry is already at the edge of the stack.",
      );
      [state.stack[current], state.stack[target]] = [
        state.stack[target],
        state.stack[current],
      ];
      break;
    }
    case "resolve":
    case "counterSpell":
      finishEntry(state, action);
      break;
    case "nextStep":
      if (state.firstStrikeDamage) delete state.firstStrikeDamage;
      else if (state.step === steps.length - 1) nextTurn(state);
      else state.step++;
      break;
    case "nextTurn":
      nextTurn(state);
      break;
    case "setStep":
      requireThat(
        Number.isInteger(action.step) && steps[action.step],
        "Unknown turn step.",
      );
      state.step = action.step;
      delete state.firstStrikeDamage;
      break;
    default:
      throw new Error("Unknown game action.");
  }
  return state;
}

const object = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === "string";
const nullableText = (v: unknown) => v === null || text(v);
const integer = (v: unknown): v is number => Number.isSafeInteger(v);
const natural = (v: unknown): v is number => integer(v) && v >= 0;
const counterMap = (value: unknown) =>
  object(value) &&
  Object.entries(value).every(
    ([key, count]) =>
      !!key && !Object.hasOwn(Object.prototype, key) && natural(count),
  );
const isSeat = (v: unknown): v is Seat => v === 0 || v === 1;
const flags = (v: Record<string, unknown>, keys: string[]) =>
  keys.every((k) => typeof v[k] === "boolean");
function isPrinting(id: string, card: unknown) {
  return (
    object(card) &&
    card.id === id &&
    !Object.hasOwn(Object.prototype, id) &&
    [
      "oracleId",
      "name",
      "setCode",
      "setName",
      "collectorNumber",
      "rarity",
      "manaCost",
      "typeLine",
      "oracleText",
    ].every((k) => text(card[k])) &&
    typeof card.cmc === "number" &&
    Number.isFinite(card.cmc) &&
    natural(card.owned) &&
    nullableText(card.imageUri) &&
    nullableText(card.backImageUri) &&
    Array.isArray(card.colors) &&
    card.colors.every(text)
  );
}

/** Check both shape and card conservation before replacing a live match with saved data. */
export function validateMatch(value: unknown): value is Match {
  if (
    !object(value) ||
    value.version !== 1 ||
    !Array.isArray(value.players) ||
    value.players.length !== 2 ||
    !object(value.catalog) ||
    !object(value.pieces) ||
    !Array.isArray(value.stack) ||
    !isSeat(value.active) ||
    !natural(value.step) ||
    value.step >= steps.length ||
    (value.firstStrikeDamage !== undefined &&
      (typeof value.firstStrikeDamage !== "boolean" ||
        (value.firstStrikeDamage && value.step !== 7))) ||
    (value.handoffDecision !== undefined &&
      !(
        object(value.handoffDecision) &&
        isSeat(value.handoffDecision.seat) &&
        text(value.handoffDecision.text) &&
        Array.isArray(value.handoffDecision.choices) &&
        value.handoffDecision.choices.every(text)
      )) ||
    !natural(value.turn) ||
    value.turn < 1 ||
    !natural(value.nextId) ||
    value.nextId < 1
  )
    return false;
  const { catalog, pieces, nextId } = value;
  if (!Object.entries(catalog).every(([id, c]) => isPrinting(id, c)))
    return false;
  const hasPrinting = (id: unknown) => text(id) && Object.hasOwn(catalog, id);
  const generated = (id: string, prefix: string) => {
    if (!id.startsWith(prefix)) return false;
    const suffix = id.slice(prefix.length);
    return /^[1-9][0-9]*$/.test(suffix) && Number(suffix) < nextId;
  };
  for (const [id, card] of Object.entries(pieces)) {
    if (
      !object(card) ||
      Object.hasOwn(Object.prototype, id) ||
      !id ||
      card.id !== id ||
      !isSeat(card.owner) ||
      !isSeat(card.controller) ||
      !nullableText(card.tokenName) ||
      (card.printing === null
        ? !text(card.tokenName)
        : !hasPrinting(card.printing)) ||
      (card.tokenName !== null && !generated(id, "token-")) ||
      !nullableText(card.attachedTo) ||
      !flags(card, ["tapped", "revealed", "back", "faceDown"]) ||
      (card.faceDownVisibleTo !== undefined &&
        !(
          Array.isArray(card.faceDownVisibleTo) &&
          card.faceDownVisibleTo.every(isSeat)
        )) ||
      ![null, "attacking", "blocking"].includes(card.combat as string | null) ||
      !counterMap(card.counters) ||
      (card.chosenType !== undefined && !text(card.chosenType)) ||
      (card.damage !== undefined && !natural(card.damage)) ||
      (card.power !== undefined && !integer(card.power)) ||
      (card.toughness !== undefined && !integer(card.toughness)) ||
      (card.attachedToPlayer !== undefined && !isSeat(card.attachedToPlayer)) ||
      (card.combatTargets !== undefined &&
        !(
          Array.isArray(card.combatTargets) && card.combatTargets.every(text)
        )) ||
      [card.summoningSick, card.phasedOut].some(
        (flag) => flag !== undefined && typeof flag !== "boolean",
      )
    )
      return false;
  }
  const seen = new Set<string>();
  const battlefield = new Set<string>();
  const claim = (id: unknown): id is string => {
    if (!text(id) || seen.has(id) || !Object.hasOwn(pieces, id)) return false;
    seen.add(id);
    return true;
  };
  for (const seat of seats) {
    const p: unknown = value.players[seat];
    if (
      !object(p) ||
      !text(p.deckName) ||
      !integer(p.life) ||
      (p.counters !== undefined && !counterMap(p.counters)) ||
      !natural(p.mulligans) ||
      p.mulligans > 7 ||
      typeof p.kept !== "boolean" ||
      !object(p.mana) ||
      !object(p.zones)
    )
      return false;
    const mana = p.mana;
    const hand = p.zones.hand;
    if (
      p.openingBottom !== undefined &&
      !(
        Array.isArray(p.openingBottom) &&
        p.openingBottom.length <= p.mulligans &&
        new Set(p.openingBottom).size === p.openingBottom.length &&
        p.openingBottom.every(
          (id) => text(id) && Array.isArray(hand) && hand.includes(id),
        )
      )
    )
      return false;
    if (!manaTypes.every((key) => natural(mana[key]))) return false;
    if (
      Object.entries(p.zones).some(
        ([name, pile]) =>
          !zones.some((zone) => zone === name) &&
          (!Array.isArray(pile) || pile.length > 0),
      )
    )
      return false;
    for (const zone of zones) {
      const pile = p.zones[zone];
      if (zone === "command" && pile === undefined) continue;
      if (!Array.isArray(pile)) return false;
      for (const id of pile) {
        if (!claim(id)) return false;
        const card = pieces[id] as Piece;
        if (zone === "battlefield") {
          if (card.controller !== seat) return false;
          battlefield.add(id);
        } else if (
          card.owner !== seat ||
          card.controller !== seat ||
          (card.tokenName !== null && zone !== "command")
        )
          return false;
      }
    }
  }
  const stackIds = new Set<string>();
  for (const item of value.stack as unknown[]) {
    if (
      !object(item) ||
      !text(item.id) ||
      !generated(item.id, "stack-") ||
      stackIds.has(item.id) ||
      !isSeat(item.controller) ||
      !text(item.label) ||
      (item.description !== undefined && !text(item.description)) ||
      !text(item.targets) ||
      !nullableText(item.source) ||
      !(item.copyPrinting === null || hasPrinting(item.copyPrinting)) ||
      !flags(item, ["copyFaceDown", "copyBack"]) ||
      !["spell", "copy", "ability"].includes(item.kind as string) ||
      (item.kind === "copy"
        ? !["spell", "ability"].includes(item.copyKind as string)
        : item.copyKind !== null) ||
      (item.copyKind !== "spell" &&
        (item.copyPrinting !== null || item.copyBack || item.copyFaceDown)) ||
      (item.copyFaceDown &&
        (item.copyPrinting !== null ||
          item.source !== null ||
          item.copyBack ||
          item.label !== "Face-down spell")) ||
      (item.kind === "spell" ? !claim(item.card) : item.card !== null)
    )
      return false;
    stackIds.add(item.id);
  }
  if (seen.size !== Object.keys(pieces).length) return false;
  // Validate attachment chains, including cycles, before the reducer follows them.
  const checked = new Set<string>();
  for (const [id, card] of Object.entries(pieces) as [string, Piece][]) {
    if (card.attachedTo !== null && !battlefield.has(id)) return false;
    const path = new Set<string>([id]);
    let next = card.attachedTo;
    while (next !== null && !checked.has(next)) {
      if (!battlefield.has(next) || path.has(next)) return false;
      path.add(next);
      next = (pieces[next] as Piece).attachedTo;
    }
    if (next !== null && !battlefield.has(next)) return false;
    for (const visited of path) checked.add(visited);
  }
  return true;
}
