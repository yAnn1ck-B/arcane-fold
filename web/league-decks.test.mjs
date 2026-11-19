import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import { creatureSuggestions, filterOptions, queryCards } from "./card-browser.mjs";
import { deckCatalogCommand, getPlayableDeck, playableDecks } from "./league-decks.mjs";

const card = (id, properties = {}) => ({
  id, oracleId: id, name: id, setCode: "fdn", setName: "Foundations", collectorNumber: "1",
  rarity: "common", colors: ["G"], oracleText: "", typeLine: "Creature — Elf Druid",
  cmc: 1, owned: 0, oracleOwned: 0, ...properties,
});

test("catalog groups printings after filtering and shares ownership with alternate artwork", () => {
  const original = card("art-1", {name:"Forest Scout", oracleId:"scout", owned:2, oracleOwned:2, oracleText:"Gain 3 life."});
  const alternate = {...original, id:"art-2", owned:0, collectorNumber:"2"};
  const land = card("land", {name:"Forest", colors:[], typeLine:"Basic Land — Forest", cmc:0});
  const list = [alternate, original, land];
  assert.deepEqual(queryCards(list, {groupByOracle:true, ownedOnly:true, search:"gain life"}).cards, [original]);
  assert.deepEqual(queryCards(list, {availableOnly:true, includeBasicLands:true, allocated:{scout:2}}).cards, [land]);
  assert.deepEqual(queryCards(list, {manaValues:[0],cardTypes:["Land"],colors:["C"]}).cards, [land]);
  assert.deepEqual(creatureSuggestions(list, {ownedOnly:true}, "dr"), ["Druid"]);
  const facets = filterOptions(list, {ownedOnly:true, rarity:"mythic"});
  assert.deepEqual(facets.sets, [{code:"fdn", name:"Foundations", count:1}]);
  assert.deepEqual(facets.colors, ["G"]);
  assert.deepEqual(facets.cardTypes, ["Creature"]);
});

test("PostgreSQL deck creation retries, player isolation, Forge serialization and pooled ownership",
  {skip: !process.env.DATABASE_URL && !process.env.PGDATABASE}, async () => {
  const client = new pg.Client(process.env.DATABASE_URL ? {connectionString:process.env.DATABASE_URL} : {});
  await client.connect();
  try {
    await client.query("BEGIN");
    const schema = "test_decks_" + randomUUID().replaceAll("-", "");
    await client.query("CREATE SCHEMA " + schema);
    await client.query("SET LOCAL search_path TO " + schema);
    for (const file of ["schema.sql","league.sql","decks.sql"]) {
      await client.query(await readFile(new URL(file,import.meta.url),"utf8"));
    }
    const player = randomUUID(), other = randomUUID();
    for (const id of [player,other]) await client.query("INSERT INTO web_players(id,session_hash) VALUES($1,$2)",[id,id]);
    const forest = card("forest", { name:"Forest", typeLine:"Basic Land — Forest" });
    const elf = card("elf-1", { name:"Llanowar Elves", oracleId:"elf" });
    const alternate = {...elf, id:"elf-2", collectorNumber:"227"};
    const locked = {...elf, id:"locked",setCode:"future-test"};
    for (const printing of [forest,elf,alternate,locked]) {
      await client.query("INSERT INTO web_cards(id,data) VALUES($1,$2)",[printing.id,printing]);
    }
    await client.query("INSERT INTO web_owned VALUES($1,$2,2)",[player,elf.id]);
    const call = (command,args,who = player) => deckCatalogCommand(client,who,command,args);
    const draft = {id:null, name:"Elf test", cards:[
      {cardId:forest.id,section:"main",quantity:7},
      {cardId:alternate.id,section:"main",quantity:1},
      {cardId:alternate.id,section:"sideboard",quantity:1},
    ]};
    const request = {deck:draft,createRequestId:randomUUID()};
    const first = await call("save_deck",request);
    const {deck:again,export:exported} = await call("save_deck_to_forge",request);
    assert.equal(first.id,again.id);
    assert.equal((await call("list_decks")).length,1);
    assert.match(exported.content,/1 Llanowar Elves\|FDN\|\[227\]/);
    assert.equal((await getPlayableDeck(client,player,first.id)).text,exported.content);
    assert.ok((await playableDecks(client,player)).some(deck => deck.id === first.id));
    assert.ok(!(await playableDecks(client,other)).some(deck => deck.id === first.id));
    await assert.rejects(call("load_deck",{id:first.id},other), /unavailable/);
    await assert.rejects(call("save_deck",{deck:{...draft,id:first.id,cards:[]}},other), /unavailable/);
    await assert.rejects(call("save_deck",{deck:draft},other), /own 0/);
    await assert.rejects(call("save_deck",{deck:{...draft,cards:[...draft.cards,{cardId:elf.id,section:"main",quantity:1}]}}), /one printing/);
    await assert.rejects(call("save_deck",{deck:{...draft,cards:[{cardId:locked.id,section:"main",quantity:1}]}}), /unlocked/);
    assert.equal((await call("query_cards",{query:{groupByOracle:true,ownedOnly:true}})).cards[0].id,elf.id);
    assert.equal((await call("get_card",{cardId:alternate.id})).oracleOwned,2);
    assert.deepEqual((await call("card_printings",{oracleId:"elf"})).map(card => card.id),[elf.id,alternate.id]);
    const validation = await call("validate_deck",{deck:draft});
    assert.equal(validation.canExport,false);
    assert.match(validation.warnings.join(" "),/at least/);
    assert.deepEqual(await call("load_dashboard_stats"),{uniqueCards:1,totalCards:2,decks:1,wildcards:0});
    await call("delete_deck",{id:first.id});
    await assert.rejects(call("save_deck",request),/unavailable/);
    assert.equal((await call("list_decks")).length,0);
  } finally {
    await client.query("ROLLBACK").finally(() => client.end());
  }
});
