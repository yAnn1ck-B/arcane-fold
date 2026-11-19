import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { boosterPool, drawPack } from "./league-boosters.mjs";
import { enabledSetCodes, entitledWildcards, leagueCommand, planOpening, rules } from "./league.mjs";

const weekMs = 7 * 24 * 60 * 60 * 1000;
const atWeek = week => rules.startedAt * 1000 + week * weekMs;

test("shared-calendar grants and unlocks use the published anchor", () => {
  assert.equal(rules.startedAt, 1794847589);
  assert.deepEqual(entitledWildcards(0), { common: 10, uncommon: 5, rare: 2, mythic: 1, discovery: 1 });
  assert.deepEqual(entitledWildcards(2), { common: 18, uncommon: 9, rare: 3, mythic: 2, discovery: 1 });
  assert.deepEqual(entitledWildcards(4), { common: 26, uncommon: 13, rare: 4, mythic: 2, discovery: 2 });
  assert.equal(entitledWildcards(6).mythic, 3);
  assert.equal(entitledWildcards(8).discovery, 3);
  assert.deepEqual(enabledSetCodes(atWeek(4) - 1), ["fdn"]);
  assert.deepEqual(enabledSetCodes(atWeek(4)), ["fdn", "blb"]);
});

const card = (id, rarity, extra = {}) => ({
  id, oracleId: id, name: id, typeLine: "Creature — Elf", rarity, setCode: "fdn", booster: true, ...extra,
});
test("pack rarity, land preferences and Oracle protection survive alternative artworks and exhausted pools", () => {
  const cards = [card("a","common"),card("a2","common",{ oracleId: "a" }),card("b","common"),
    card("landa","common",{ typeLine: "Land" }),card("landb","common",{ typeLine: "Land" }),
    card("basic","common",{ typeLine: "Basic Land — Island" }),card("promo","rare",{ promo: true }),
    card("extra","rare",{ booster: false }),card("u","uncommon"),card("r","rare"),card("m","mythic")];
  const pools = boosterPool(cards, "fdn", rules.booster);
  assert.equal(pools.common.length, 4);
  assert.equal(pools.rare.length, 1);
  const owned = new Map([["a",3],["landa",4],["landb",4]]);
  const pack = drawPack(pools, rules, owned, () => 0);
  assert.equal(pack.cards.filter(c => c.rarity === "common").length, 5);
  assert.equal(pack.duplicateWildcards.common, 5);
  assert.equal(owned.get("a"), 4);
  assert.equal(pack.cards.at(-1).rarity, "mythic");
  assert.ok(pack.cards.every(c => c.id !== "basic" && c.id !== "promo" && c.id !== "extra"));
  const next = drawPack(pools, rules, owned, () => 0.9);
  assert.equal(next.duplicateWildcards.common, 10);
  assert.equal(next.duplicateWildcards.uncommon, 4);
  assert.equal(next.cards.at(-1).rarity, "rare");
});

test("queued openings preserve calendar order and named openings spend matching bonus packs first", () => {
  const rows = [
    { grant_id:"old", set_code:"fdn", source:"general", remaining:2 },
    { grant_id:"bonus", set_code:"blb", source:"bonus", remaining:8 },
    { grant_id:"weekly", set_code:"blb", source:"general", remaining:6 },
  ];
  assert.deepEqual(planOpening(rows,3), [
    { grantId:"old",code:"fdn",quantity:2 },{ grantId:"bonus",code:"blb",quantity:1 },
  ]);
  assert.deepEqual(planOpening(rows,9,"blb"), [
    { grantId:"bonus",code:"blb",quantity:8 },{ grantId:"old",code:"blb",quantity:1 },
  ]);
  assert.throws(() => planOpening(rows,9,"fdn"), /8 packs/);
});

test("PostgreSQL receipts bind the player and request, wildcard and pack grants survive retries", {
  skip: process.env.TEST_WEB_POSTGRES !== "1",
}, async t => {
  const { Client } = (await import("pg")).default;
  const db = new Client(process.env.DATABASE_URL ? {connectionString:process.env.DATABASE_URL} : {});
  await db.connect();
  t.after(async () => { try { await db.query("ROLLBACK"); } finally { await db.end(); } });
  await db.query("BEGIN");
  await db.query("SET LOCAL search_path TO pg_temp,pg_catalog");
  await db.query("CREATE TEMP TABLE web_players(id uuid PRIMARY KEY); CREATE TEMP TABLE web_cards(id text PRIMARY KEY,data jsonb NOT NULL)");
  const schema = await readFile(new URL("./league.sql",import.meta.url),"utf8");
  await db.query(schema.replaceAll("CREATE TABLE IF NOT EXISTS", "CREATE TEMP TABLE"));
  const [one, two] = [randomUUID(),randomUUID()];
  await db.query("INSERT INTO web_players VALUES ($1),($2)",[one,two]);
  for (const c of [
    card("a","common"),card("u","uncommon"),card("r","rare"),card("m","mythic"),
    card("prize","rare",{ booster:false }),card("art","rare",{ oracleId:"prize", booster:false }),
    card("locked","rare",{ setCode:"blb" }),
  ]) await db.query("INSERT INTO web_cards VALUES ($1,$2)",[c.id,c]);
  let now = atWeek(0);
  t.mock.method(Date,"now",() => now);
  const call = (player,command,args) => leagueCommand(db,player,command,args);
  assert.equal((await call(one,"league_status")).availablePacks,20);
  const craft = { cardId:"prize", wildcardKind:"discovery", requestId:"spend" };
  assert.equal((await call(one,"craft_card",craft)).card.oracleOwned,1);
  assert.equal((await call(one,"craft_card",craft)).wildcards.discovery,0);
  assert.equal((await call(one,"league_status")).wildcards.discovery,0);
  await assert.rejects(call(one,"craft_card",{...craft,cardId:"art"}), /different request/);
  await assert.rejects(call(one,"craft_card",{...craft,cardId:"locked",requestId:"locked"}), /locked/);
  assert.equal((await call(one,"craft_card",{cardId:"art",wildcardKind:"rare",requestId:"copy"})).card.oracleOwned,2);
  const request = {count:1,requestId:"pack"};
  assert.equal(await call(one,"resolve_booster_opening",request),null);
  const pack = await call(one,"open_next_boosters",request);
  assert.deepEqual(await call(one,"open_next_boosters",request),pack);
  assert.deepEqual(await call(one,"resolve_booster_opening",request),pack);
  await assert.rejects(call(one,"resolve_booster_opening",{...request,count:2}), /different request/);
  assert.equal((await call(one,"league_status")).availablePacks,19);
  assert.equal((await call(one,"league_status")).history.length,1);
  assert.equal(pack.duplicateWildcards.common,6);
  assert.equal(await call(two,"resolve_booster_opening",request),null);
  await assert.rejects(call(two,"craft_card",craft), /Begin your league/);
  await call(two,"begin_league");
  assert.equal((await call(two,"craft_card",craft)).wildcards.discovery,0);
  assert.equal((await call(two,"league_status")).availablePacks,20);
  now = atWeek(4);
  const due = await call(two,"begin_league");
  assert.equal(due.claimablePacks,32);
  assert.equal(due.claimableWildcards.discovery,1);
  assert.equal((await call(two,"claim_weekly_reward")).availablePacks,52);
  await assert.rejects(call(two,"claim_weekly_reward"), /already claimed/);
  const later = await call(one,"league_status");
  assert.equal(later.availablePacks,51);
  assert.equal(later.setPacks.blb,8);
  assert.equal(later.wildcards.discovery,1);
  assert.equal((await call(one,"league_status")).wildcards.discovery,1);
  now = atWeek(0);
  assert.equal((await call(one,"league_status")).wildcards.discovery,1);
});
