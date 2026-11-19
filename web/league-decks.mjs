import { randomUUID } from "node:crypto";
import { creatureSuggestions, filterOptions, preferPrinting, queryCards } from "./card-browser.mjs";
import { basic } from "./league-boosters.mjs";
import { enabledSetCodes, rules } from "./league.mjs";
import { forgeDeck, forgeFilename } from "./forge-deck.mjs";
import { practiceDecks } from "./practice.mjs";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = () => Object.assign(new Error("This saved deck is unavailable."), { status: 404 });
const moxes = ["Mox Pearl","Mox Sapphire","Mox Jet","Mox Ruby","Mox Emerald"];
const numbers = "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty".split(" ");

async function cardsFor(db, playerId, predicate, value) {
  // Oracle totals include owned alternate printings outside the current filter.
  const { rows } = await db.query(`
    WITH totals AS (
      SELECT c.data->>'oracleId' AS oracle, SUM(o.quantity)::integer AS owned
      FROM web_owned o JOIN web_cards c ON c.id=o.card_id
      WHERE o.player_id=$1 GROUP BY c.data->>'oracleId'
    )
    SELECT c.id, c.data, COALESCE(o.quantity,0) AS owned, COALESCE(t.owned,0) AS "oracleOwned"
    FROM web_cards c LEFT JOIN web_owned o ON o.card_id=c.id AND o.player_id=$1
    LEFT JOIN totals t ON t.oracle=c.data->>'oracleId' WHERE ${predicate}`, [playerId, value]);
  return rows.map(({id, data, owned, oracleOwned}) => ({ ...data, id, owned, oracleOwned }));
}

async function browsable(db, playerId) {
  return cardsFor(db, playerId, "(c.data->>'setCode') = ANY($2::text[]) AND (c.data->>'eligible') IS DISTINCT FROM 'false'", enabledSetCodes());
}

function normalizeDraft(deck) {
  const name = typeof deck?.name === "string" && deck.name.trim();
  if (!name || [...name].length > 100 || /[\p{Cc}\[\]|]/u.test(name)) throw new Error("Use a deck name of 1–100 characters without control characters, brackets or pipes.");
  if (!Array.isArray(deck.cards) || deck.cards.length > 2000) throw new Error("Use at most 2,000 printing entries in a deck.");
  const groups = new Map();
  for (const { cardId, section, quantity } of deck.cards) {
    if (typeof cardId !== "string" || !cardId || !["main","sideboard"].includes(section)
      || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 100000) throw new Error("Invalid deck entry or card quantity.");
    const key = JSON.stringify([cardId,section]);
    const total = (groups.get(key)?.quantity ?? 0) + quantity;
    if (total > 100000) throw new Error("Too many copies of a printing in one section.");
    groups.set(key,{ cardId, section, quantity: total });
  }
  return { id: deck.id ?? null, name, cards: [...groups.values()] };
}

async function entriesFor(db, playerId, rows) {
  const ids = [...new Set(rows.map(entry => entry.cardId))];
  if (!ids.length) return [];
  const printings = await cardsFor(db, playerId, "c.id = ANY($2::text[])", ids);
  const cards = new Map(printings.map(card => [card.id,card]));
  return rows.map(({cardId,section,quantity}) => {
    const card = cards.get(cardId);
    if (!card) throw new Error("A deck printing is missing from the catalog.");
    return {card,section,quantity};
  });
}

function limit(card) {
  if (basic(card) || /a deck can have any number of cards named/i.test(card.oracleText)) return Infinity;
  if (/a deck can have only one card named/i.test(card.oracleText)) return 1;
  const word = /a deck can have up to (\w+) cards named/i.exec(card.oracleText)?.[1]?.toLowerCase();
  const explicit = Number(word) || numbers.indexOf(word);
  return explicit > 0 ? explicit : rules.deckRestrictions.normalCopyLimit;
}

function inspect(entries) {
  const groups = new Map();
  const required = [], warnings = [];
  const unlocked = new Set(enabledSetCodes());
  let mainCount = 0, sideboardCount = 0;
  for (const {card,section,quantity} of entries) {
    if (section === "main") mainCount += quantity;
    else sideboardCount += quantity;
    if (!unlocked.has(card.setCode) || card.eligible === false) required.push(`Choose an unlocked league printing of ${card.name}.`);
    const group = groups.get(card.oracleId) ?? { card, count: 0 };
    if (group.card.id !== card.id) required.push(`Choose one printing of ${card.name} for the whole deck, including the sideboard.`);
    group.count += quantity;
    groups.set(card.oracleId,group);
  }
  const restrictions = rules.deckRestrictions;
  if (mainCount < restrictions.minimumMainDeck) warnings.push(`The main deck has ${mainCount} cards. Your league requires at least ${restrictions.minimumMainDeck}.`);
  if (sideboardCount > restrictions.maximumSideboard) warnings.push(`The sideboard has ${sideboardCount} cards. Your league maximum is ${restrictions.maximumSideboard}.`);
  for (const {card,count} of groups.values()) {
    if (!basic(card) && count > card.oracleOwned) required.push(`You own ${card.oracleOwned} copies of ${card.name} and allocated ${count}.`);
    if (count > limit(card)) warnings.push(`${card.name} has ${count} copies. Its limit is ${limit(card)} across the main deck and sideboard.`);
  }
  return { mainCount, sideboardCount, required, warnings: [...new Set([...required,...warnings])], canExport: !warnings.length && !required.length };
}

async function listDecks(db, playerId) {
  const { rows } = await db.query(`SELECT d.id,d.name,d.created_at AS "createdAt",d.updated_at AS "updatedAt",
    COALESCE(SUM((c->>'quantity')::integer) FILTER (WHERE c->>'section'='main'),0)::integer AS "mainCount",
    COALESCE(SUM((c->>'quantity')::integer) FILTER (WHERE c->>'section'='sideboard'),0)::integer AS "sideboardCount"
    FROM web_decks d LEFT JOIN LATERAL jsonb_array_elements(d.cards) AS c ON TRUE
    WHERE player_id=$1 GROUP BY d.id ORDER BY d.updated_at DESC,d.name,d.id`, [playerId]);
  return rows;
}

async function loadDeck(db, playerId, id) {
  if (!uuid.test(id)) throw notFound();
  const {rows:[row]} = await db.query('SELECT id,name,created_at AS "createdAt",updated_at AS "updatedAt",cards FROM web_decks WHERE player_id=$1 AND id=$2',[playerId,id]);
  if (!row) throw notFound();
  return { ...row, cards: await entriesFor(db,playerId,row.cards) };
}

async function saveDeck(db, playerId, input, createRequestId) {
  const deck = normalizeDraft(input);
  const entries = await entriesFor(db,playerId,deck.cards);
  const { required } = inspect(entries);
  if (required.length) throw new Error(required[0]);
  let id = deck.id;
  if (createRequestId !== undefined && createRequestId !== null) {
    if (typeof createRequestId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(createRequestId)) throw new Error("Invalid deck creation identifier.");
    const {rows:[receipt]} = await db.query("SELECT deck_id FROM web_deck_creations WHERE player_id=$1 AND request_id=$2",[playerId,createRequestId]);
    if (receipt) {
      if (id && id !== receipt.deck_id) throw new Error("This creation identifier belongs to another deck.");
      id = receipt.deck_id;
    } else {
      if (id) throw new Error("A creation identifier can only be assigned to a new deck.");
      const newId = randomUUID();
      await db.query("INSERT INTO web_deck_creations(player_id,request_id,deck_id) VALUES($1,$2,$3)",[playerId,createRequestId,newId]);
      deck.id = newId;
    }
  }
  let row;
  if (id) {
    if (!uuid.test(id)) throw notFound();
    ({rows:[row]} = await db.query('UPDATE web_decks SET name=$3,cards=$4::jsonb,updated_at=clock_timestamp() WHERE id=$1 AND player_id=$2 RETURNING id,name,created_at AS "createdAt",updated_at AS "updatedAt"', [id,playerId,deck.name,JSON.stringify(deck.cards)]));
    if (!row) throw notFound();
  } else {
    ({rows:[row]} = await db.query('INSERT INTO web_decks(id,player_id,name,cards) VALUES($1,$2,$3,$4::jsonb) RETURNING id,name,created_at AS "createdAt",updated_at AS "updatedAt"', [deck.id || randomUUID(),playerId,deck.name,JSON.stringify(deck.cards)]));
  }
  return { ...row, cards: entries };
}

function deckSizeProblem(count) {
  if (count < 7) return "Needs at least 7 main-deck cards";
  if (count > 2000) return "Maximum 2,000 main-deck cards";
  return null;
}

export async function playDeckOptions(db, playerId) {
  const saved = await listDecks(db,playerId);
  return [
    ...saved.map(({id,name,mainCount}) => ({id,name,unavailableReason:deckSizeProblem(mainCount)})),
    ...practiceDecks.map(({id,name,practice}) => ({id,name,practice})),
  ];
}

export async function getPlayableDeck(db, playerId, id) {
  const practice = practiceDecks.find(deck => deck.id === id);
  if (practice) return practice;
  const deck = await loadDeck(db,playerId,id);
  const {required,mainCount} = inspect(deck.cards);
  if (required.length) throw new Error(required[0]);
  const sizeProblem = deckSizeProblem(mainCount);
  if (sizeProblem) throw new Error(sizeProblem + ".");
  return { id, name: deck.name, text: forgeDeck(deck.name,deck.cards) };
}

export async function deckCatalogCommand(db, playerId, command, args = {}) {
  switch (command) {
    case "query_cards": return queryCards(await browsable(db,playerId),args.query);
    case "card_filter_options": return filterOptions(await browsable(db,playerId),args.query);
    case "search_creature_types": return creatureSuggestions(await browsable(db,playerId),args.query,args.search);
    case "card_printings": {
      const cards = await cardsFor(db,playerId,"c.data->>'oracleId'=$2",args.oracleId);
      const unlocked = new Set(enabledSetCodes());
      return cards.filter(card => unlocked.has(card.setCode) && card.eligible !== false).sort(preferPrinting);
    }
    case "get_card": {
      const [card] = await cardsFor(db,playerId,"c.id=$2",args.cardId);
      if (!card) throw new Error("This printing is missing from the catalog.");
      return card;
    }
    case "resolve_card_image": return "/api/art?" + new URLSearchParams({ id: args.cardId, face: args.face === "back" ? "back" : "front" });
    case "get_banner_card":
    case "get_banner_moxes": {
      const names = command === "get_banner_card" ? ["Black Lotus"] : moxes;
      const cards = await cardsFor(db,playerId,"(c.data->>'name') = ANY($2::text[])",names);
      cards.sort((a,b) => Number(b.setCode === "vma") - Number(a.setCode === "vma") || preferPrinting(a,b));
      const banners = names.map(name => cards.find(card => card.name === name)).filter(Boolean);
      return command === "get_banner_card" ? banners[0] ?? null : banners;
    }
    case "list_sets": {
      const {rows} = await db.query("SELECT data->>'setCode' AS code, max(data->>'setName') AS name, count(*)::integer AS count FROM web_cards GROUP BY data->>'setCode' ORDER BY name");
      return rows;
    }
    case "catalog_status": case "ensure_catalog": {
      const {rows:[row]} = await db.query('SELECT count(*)::integer AS count FROM web_cards');
      return {...row, updatedAt: null};
    }
    case "load_dashboard_stats": {
      const {rows:[row]} = await db.query(`SELECT count(*) FILTER (WHERE quantity>0)::integer AS "uniqueCards",COALESCE(sum(quantity),0)::integer AS "totalCards",
        (SELECT count(*)::integer FROM web_decks WHERE player_id=$1) AS decks,
        COALESCE((SELECT SUM(value::integer)::integer FROM web_economy e CROSS JOIN LATERAL jsonb_each_text(e.wildcards) WHERE e.player_id=$1),0) AS wildcards
        FROM web_owned WHERE player_id=$1`,[playerId]);
      return row;
    }
    case "list_decks": return listDecks(db,playerId);
    case "load_deck": return loadDeck(db,playerId,args.id);
    case "save_deck": return saveDeck(db,playerId,args.deck,args.createRequestId);
    case "delete_deck": {
      if (!uuid.test(args.id)) throw notFound();
      const result = await db.query("DELETE FROM web_decks WHERE player_id=$1 AND id=$2",[playerId,args.id]);
      if (!result.rowCount) throw notFound();
      return null;
    }
    case "duplicate_deck": {
      const source = await loadDeck(db,playerId,args.id);
      const cards = source.cards.map(({card,section,quantity}) => ({cardId:card.id,section,quantity}));
      return saveDeck(db,playerId,{name:[...source.name].slice(0,90).join("") + " (copy)",cards});
    }
    case "validate_deck": case "export_deck": {
      const draft = normalizeDraft(args.deck);
      const entries = await entriesFor(db,playerId,draft.cards);
      const {mainCount,sideboardCount,warnings,canExport} = inspect(entries);
      if (command === "validate_deck") return {mainCount,sideboardCount,warnings,canExport};
      if (!canExport) throw new Error(warnings.join(" "));
      return {path:forgeFilename(draft.name),content:forgeDeck(draft.name,entries)};
    }
    default: return undefined;
  }
}
