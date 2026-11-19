import { readFile } from "node:fs/promises";
import { randomInt } from "node:crypto";
import { basic, boosterPool, craftable, drawPack, emptyBalances, kinds, rarities } from "./league-boosters.mjs";

export const rules = JSON.parse(await readFile(new URL("../src-tauri/league-rules.json", import.meta.url), "utf8"));
const weekMs = 7 * 86400 * 1000;
const period = now => Math.max(0, Math.floor((now - rules.startedAt * 1000) / weekMs));
const unlocks = [
  ...rules.expansionSchedule,
  ...rules.autoUnlock.setCodes.map((code, i) => ({ code, week: (i + 1) * rules.autoUnlock.intervalWeeks }))
    .filter(() => rules.autoUnlock.intervalWeeks > 0),
].sort((a, b) => a.week - b.week);
export function enabledSetCodes(now = Date.now()) {
  return [...new Set([...rules.enabledSets, ...unlocks.filter(item => item.week <= period(now)).map(item => item.code)]
    .map(code => code.toLowerCase()))];
}
function packSet(week) {
  return (unlocks.filter(item => item.week <= week).at(-1)?.code ?? rules.enabledSets[0]).toLowerCase();
}
export function entitledWildcards(week) {
  return Object.fromEntries(kinds.map(kind => {
    const interval = rules.wildcardRewardIntervals[kind];
    const offset = rules.wildcardRewardOffsets[kind];
    const grants = Math.floor((week + offset) / interval) - Math.floor(offset / interval);
    return [kind, rules.startingWildcards[kind] + grants * rules.weeklyWildcards[kind]];
  }));
}
function addBalances(balances, reward) {
  for (const kind of kinds) {
    balances[kind] += reward[kind];
    if (!Number.isInteger(balances[kind]) || balances[kind] < 0 || balances[kind] > 2147483647) {
      throw new Error("The wildcard balance is outside the supported range.");
    }
  }
}

async function getEconomy(db, player) {
  return (await db.query("SELECT wildcards,entitlements FROM web_economy WHERE player_id=$1", [player])).rows[0];
}
async function saveBalances(db, player, balances) {
  await db.query("UPDATE web_economy SET wildcards=$2 WHERE player_id=$1", [player, balances]);
}
async function queue(db, player) {
  return (await db.query(`SELECT grant_id,set_code,source,remaining FROM web_pack_queue
    WHERE player_id=$1 AND remaining>0 ORDER BY period,priority,grant_id`, [player])).rows;
}

async function accrue(db, player, now) {
  const existing = await getEconomy(db, player);
  if (now < rules.startedAt * 1000) return existing;
  const week = Math.max(period(now), existing?.entitlements.through ?? 0);
  const entitled = entitledWildcards(week);
  const previous = existing?.entitlements.wildcards ?? emptyBalances();
  const balances = existing?.wildcards ?? emptyBalances();
  const delta = emptyBalances();
  for (const kind of kinds) {
    entitled[kind] = Math.max(previous[kind], entitled[kind]);
    delta[kind] = entitled[kind] - previous[kind];
  }
  addBalances(balances, delta);
  const grants = [];
  function grant(grant_id, set_code, source, period, priority, amount) {
    if (amount > 0) grants.push({ grant_id, set_code, source, period, priority, amount });
  }
  if (!existing) grant("starting", packSet(0), "general", 0, 0, rules.startingPacks);
  const from = existing?.entitlements.through ?? 0;
  for (let w = from + 1; w <= week; w++) grant("weekly:" + w, packSet(w), "general", w, 1, rules.weeklyPacks);
  for (const set of rules.expansionSchedule) {
    if (set.week <= week && (!existing || set.week > from)) {
      grant("expansion:" + set.code, set.code.toLowerCase(), "bonus", set.week, 0, set.bonusPacks);
    }
  }
  if (grants.length) {
    await db.query(`INSERT INTO web_pack_queue (player_id,grant_id,set_code,source,period,priority,remaining)
      SELECT $1, grant_id,set_code,source,period,priority,amount FROM jsonb_to_recordset($2::jsonb)
      AS g(grant_id text,set_code text,source text,period integer,priority integer,amount integer)
      ON CONFLICT (player_id,grant_id) DO NOTHING`, [player, JSON.stringify(grants)]);
  }
  const entitlements = { version: 1, through: week, wildcards: entitled };
  if (!existing || from !== week || kinds.some(kind => delta[kind])) {
    await db.query(`INSERT INTO web_economy (player_id,entitlements,wildcards) VALUES ($1,$2,$3)
      ON CONFLICT (player_id) DO UPDATE SET entitlements=excluded.entitlements,wildcards=excluded.wildcards`,
    [player, entitlements, balances]);
  }
  return { entitlements, wildcards: balances };
}

async function status(db, player, econ, now) {
  const week = period(now);
  const upcoming = rules.expansionSchedule.filter(item => item.week > week);
  const queued = await queue(db, player);
  let generalPacks = 0;
  const setPacks = {};
  for (const row of queued) {
    if (row.source === "general") generalPacks += row.remaining;
    else setPacks[row.set_code] = (setPacks[row.set_code] ?? 0) + row.remaining;
  }
  const available = generalPacks + Object.values(setPacks).reduce((a, b) => a + b, 0);
  const through = econ?.entitlements.through ?? week;
  const elapsed = Math.max(week - through, 0);
  const bonuses = Object.fromEntries(rules.expansionSchedule
    .filter(item => item.bonusPacks && item.week <= week && (!econ || item.week > through))
    .map(item => [item.code.toLowerCase(), item.bonusPacks]));
  const bonusCount = Object.values(bonuses).reduce((a,b) => a+b,0);
  const claimable = econ ? elapsed * rules.weeklyPacks + bonusCount : 0;
  const claimableWildcards = emptyBalances();
  const entitled = entitledWildcards(week);
  if (econ) for (const kind of kinds) {
    claimableWildcards[kind] = Math.max(0,entitled[kind] - econ.entitlements.wildcards[kind]);
  }
  const joinPacks = rules.startingPacks + week * rules.weeklyPacks + bonusCount;
  const records = (await db.query(`SELECT id,set_code,opened_at,contents FROM web_openings
    WHERE player_id=$1 ORDER BY seq DESC LIMIT 20`, [player])).rows;
  const history = records.map(row => ({
    id: row.id, setCode: row.set_code, openedAt: new Date(row.opened_at).toISOString(), ...row.contents,
  }));
  return {
    started: !!econ, startedAt: rules.startedAt, effectiveNow: new Date(now).toISOString(),
    previewWeeks: 0, week: week + 1, enabledSets: enabledSetCodes(now), history,
    availablePacks: available, openablePacks: econ ? available + claimable : joinPacks,
    generalPacks, setPacks, wildcards: econ?.wildcards ?? emptyBalances(),
    canClaimWeekly: claimable > 0, claimableWeeks: elapsed, claimablePacks: claimable,
    claimableSetPacks: econ ? bonuses : {}, claimableWildcards, joinWildcards: entitled,
    joinPacks, joinSetPacks: bonuses,
    nextRewardAt: new Date(rules.startedAt * 1000 + (claimable ? week : 1 + Math.max(through, week)) * weekMs).toISOString(),
    upcomingExpansions: upcoming, nextExpansion: upcoming[0] ?? null,
  };
}

function requestId(id) {
  if (typeof id !== "string" || !/^[a-zA-Z0-9_:-]{1,128}$/.test(id)) throw new Error("Invalid operation identifier.");
}
async function receipt(db, player, id, kind, request) {
  requestId(id);
  const row = (await db.query(`SELECT result,(kind=$3 AND request=$4::jsonb) AS matches
    FROM web_receipts WHERE player_id=$1 AND request_id=$2`, [player, id, kind, request])).rows[0];
  if (row && !row.matches) throw new Error("This identifier was already used for a different request.");
  return row?.result ?? null;
}
async function saveReceipt(db, player, id, kind, request, result) {
  await db.query(`INSERT INTO web_receipts(player_id,request_id,kind,request,result)
    VALUES ($1,$2,$3,$4,$5)`, [player,id,kind,request,result]);
  return result;
}
function openingRequest(count, setCode) {
  const named = setCode != null;
  if (!Number.isInteger(count) || count < (named ? 1 : 0) || count > (named ? 100 : 10000)) {
    throw new Error("Invalid booster opening size.");
  }
  if (named && (typeof setCode !== "string" || !/^[a-z0-9]{1,10}$/i.test(setCode.trim()))) throw new Error("Invalid set.");
  return named ? { count, setCode: setCode.trim().toLowerCase() } : { count };
}
export function planOpening(queued, count, set) {
  const candidates = set ? [
    ...queued.filter(row => row.source === "bonus" && row.set_code === set),
    ...queued.filter(row => row.source === "general"),
  ] : queued;
  const available = candidates.reduce((sum, row) => sum + row.remaining, 0);
  let left = count === 0 ? available : count;
  if (!left || left > available) throw new Error("You have " + available + " packs available for this opening.");
  if (left > 10000) throw new Error("Open up to 10,000 packs at a time.");
  const result = [];
  for (const row of candidates) {
    if (!left) break;
    const quantity = Math.min(left, row.remaining);
    result.push({ grantId: row.grant_id, code: set ?? row.set_code, quantity });
    left -= quantity;
  }
  return result;
}
async function open(db, player, request, id, now) {
  const saved = await receipt(db, player, id, "open", request);
  if (saved) return saved;
  const econ = request.setCode ? await getEconomy(db, player) : await accrue(db, player, now);
  if (!econ) throw new Error("The league has not started.");
  const plan = planOpening(await queue(db, player), request.count, request.setCode);
  const codes = [...new Set(plan.map(row => row.code))];
  if (codes.some(code => !enabledSetCodes(now).includes(code))) throw new Error("This expansion is locked.");
  const rows = (await db.query(`SELECT data FROM web_cards WHERE lower(data->>'setCode')=ANY($1::text[])
    ORDER BY id`, [codes])).rows.map(row => row.data);
  const pools = new Map(codes.map(code => [code, boosterPool(rows.filter(card =>
    card.setCode.toLowerCase() === code), code, rules.booster)]));
  const holdings = (await db.query(`SELECT c.data->>'oracleId' AS oracle, sum(o.quantity)::integer AS quantity
    FROM web_owned o JOIN web_cards c ON c.id=o.card_id WHERE o.player_id=$1 GROUP BY c.data->>'oracleId'`, [player])).rows;
  const owned = new Map(holdings.map(row => [row.oracle, row.quantity]));
  const outcomes = [], cards = [], perSetPacks = {}, printingCounts = new Map();
  const duplicates = emptyBalances();
  for (const row of plan) {
    for (let i = 0; i < row.quantity; i++) {
      const pack = drawPack(pools.get(row.code), rules, owned);
      addBalances(duplicates, pack.duplicateWildcards);
      for (const card of pack.cards) printingCounts.set(card.id, (printingCounts.get(card.id) ?? 0) + 1);
      cards.push(...pack.cards);
      outcomes.push({ id: id + ":" + outcomes.length, set_code: row.code, contents: pack });
      if (rules.wildcardDropProbability && randomInt(2 ** 32) / 2 ** 32 < rules.wildcardDropProbability) {
        econ.wildcards[rarities[randomInt(rarities.length)]]++;
      }
    }
    perSetPacks[row.code] = (perSetPacks[row.code] ?? 0) + row.quantity;
    const updated = await db.query(`UPDATE web_pack_queue SET remaining=remaining-$3
      WHERE player_id=$1 AND grant_id=$2 AND remaining >= $3`, [player,row.grantId,row.quantity]);
    if (updated.rowCount !== 1) throw new Error("The saved pack balance changed. Retry this opening.");
  }
  if (printingCounts.size) {
    const added = (await db.query(`INSERT INTO web_owned (player_id,card_id,quantity)
      SELECT $1,id,count FROM unnest($2::text[],$3::int[]) AS incoming(id,count)
      ON CONFLICT (player_id,card_id) DO UPDATE SET quantity=web_owned.quantity+excluded.quantity
      RETURNING card_id,quantity`, [player,[...printingCounts.keys()],[...printingCounts.values()]])).rows;
    const final = new Map(added.map(row => [row.card_id,row.quantity]));
    for (const card of cards) { card.owned = final.get(card.id); card.oracleOwned = owned.get(card.oracleId); }
  }
  await db.query(`INSERT INTO web_openings (player_id,id,set_code,contents)
    SELECT $1,id,set_code,contents FROM jsonb_to_recordset($2::jsonb) AS pack(id text,set_code text,contents jsonb)`,
  [player, JSON.stringify(outcomes)]);
  addBalances(econ.wildcards, duplicates);
  await saveBalances(db, player, econ.wildcards);
  return saveReceipt(db,player,id,"open",request,{
    id, packs: outcomes.length, setCode: codes.length === 1 ? codes[0] : "mixed",
    perSetPacks, cards, wildcards: econ.wildcards, duplicateWildcards: duplicates,
  });
}

async function craft(db, player, { cardId, wildcardKind, requestId: id }, now) {
  if (typeof cardId !== "string" || !cardId || cardId.length > 256 ||
      wildcardKind != null && !kinds.includes(wildcardKind)) throw new Error("Invalid craft request.");
  const request = wildcardKind == null ? { cardId } : { cardId, wildcardKind };
  const saved = await receipt(db, player, id, "craft", request);
  if (saved) return saved;
  const econ = await getEconomy(db, player);
  if (!econ) throw new Error("Begin your league before crafting.");
  const card = (await db.query("SELECT data FROM web_cards WHERE id=$1", [cardId])).rows[0]?.data;
  if (!card || !craftable(card)) throw new Error(card && basic(card) ? "Basic lands are free in the deck builder." : "Ineligible printing.");
  if (!enabledSetCodes(now).includes(card.setCode.toLowerCase())) throw new Error("This expansion is locked.");
  const quantity = (await db.query(`SELECT coalesce(sum(o.quantity),0)::int AS n FROM web_owned o
    JOIN web_cards c ON c.id=o.card_id WHERE o.player_id=$1 AND c.data->>'oracleId'=$2`, [player,card.oracleId])).rows[0].n;
  if (quantity >= 4) throw new Error("You own four copies across all printings of this card.");
  const kind = wildcardKind ?? card.rarity;
  if (kind === "discovery" && quantity > 0) throw new Error("Discovery grants the first copy of an unowned card.");
  if (kind !== "discovery" && (quantity === 0 || kind !== card.rarity)) {
    throw new Error("A rarity wildcard can copy an owned card of the same rarity. Use Discovery for the first copy.");
  }
  if (econ.wildcards[kind] < 1) throw new Error("You have no " + kind + " wildcard available.");
  econ.wildcards[kind]--;
  await saveBalances(db, player, econ.wildcards);
  const row = (await db.query(`INSERT INTO web_owned(player_id,card_id,quantity) VALUES ($1,$2,1)
    ON CONFLICT (player_id,card_id) DO UPDATE SET quantity=web_owned.quantity+1 RETURNING quantity`, [player,cardId])).rows[0];
  return saveReceipt(db,player,id,"craft",request,{
    card: { ...card, owned: row.quantity, oracleOwned: quantity + 1 }, wildcards: econ.wildcards,
  });
}

// Called inside the request transaction after locking the authenticated web_players row.
export async function leagueCommand(db, player, command, args = {}) {
  const now = Date.now();
  switch (command) {
    case "league_rules": return rules;
    case "league_status": return status(db, player, await accrue(db, player, now), now);
    case "begin_league": {
      const econ = await getEconomy(db, player) ?? await accrue(db, player, now);
      if (!econ) throw new Error("The league has not started.");
      return status(db, player, econ, now);
    }
    case "claim_weekly_reward": {
      const econ = await getEconomy(db, player);
      if (!econ) throw new Error("Begin your league before claiming rewards.");
      if (period(now) <= econ.entitlements.through) throw new Error("All available rewards are already claimed.");
      return status(db, player, await accrue(db, player, now), now);
    }
    case "open_next_boosters": return open(db,player,openingRequest(args.count),args.requestId,now);
    case "open_boosters":
      if (args.setCode == null) throw new Error("Choose the expansion to open.");
      return open(db,player,openingRequest(args.count,args.setCode),args.requestId,now);
    case "resolve_booster_opening": return receipt(db,player,args.requestId,"open",openingRequest(args.count,args.setCode));
    case "craft_card": return craft(db,player,args,now);
    default: throw new Error("Unknown league command.");
  }
}
