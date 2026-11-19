import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { normalize,parseEdition } from "./catalog.mjs";
import { leagueCommand } from "./league.mjs";

test("catalog requires a Forge collector number and name in an actual card section", async () => {
  const fixture = await readFile(new URL("./fixtures/forge-printing-sections.txt",import.meta.url),"utf8");
  const edition = parseEdition(fixture);
  assert.equal(edition.code,"TST");
  assert.deepEqual([...new Set(edition.entries.map(entry => entry.number))],["227","290","293","439","429","600"]);
  const index = new Map([["fdn/29",[{number:"29",name:"Front",code:"FDN"}]]]);
  const source = { object:"card",lang:"en",id:"sample",oracle_id:"oracle",set:"fdn",set_name:"Foundations",
    collector_number:"29",rarity:"rare",name:"Front // Back",games:["paper"],cmc:2,
    card_faces:[{type_line:"Creature — Elf",mana_cost:"{G}",colors:["G"],oracle_text:"Front text",
      image_uris:{normal:"https://cards.scryfall.io/normal/front/a.jpg"}},
    {type_line:"Land",oracle_text:"Back text",image_uris:{normal:"https://cards.scryfall.io/normal/back/a.jpg"}}] };
  const card = normalize(source,index);
  assert.equal(card.forgeName,"Front");
  assert.equal(card.typeLine,"Creature — Elf // Land");
  assert.equal(card.oracleText,"Front text // Back text");
  assert.equal(card.backImageUri,source.card_faces[1].image_uris.normal);
  assert.equal(card.eligible,true);
  assert.equal(normalize({...source,collector_number:"30"},index),null);
  assert.equal(normalize({...source,name:"Other"},index),null);
  assert.equal(normalize({...source,digital:true},index),null);
  assert.equal(normalize({...source,security_stamp:"acorn"},index),null);
});

test("installed web catalog matches Foundations, shows six banner artworks and opens a real fifteen-card pack", {
  skip: process.env.TEST_WEB_CATALOG !== "1",
}, async t => {
  const { Client } = (await import("pg")).default;
  const db = new Client(process.env.DATABASE_URL ? { connectionString:process.env.DATABASE_URL } : {});
  await db.connect();
  t.after(async () => { try { await db.query("ROLLBACK"); } finally { await db.end(); } });
  await db.query("BEGIN");
  const fdn = (await db.query(`SELECT count(*)::int AS printings,count(DISTINCT data->>'oracleId')::int AS names
    FROM web_cards WHERE data->>'setCode'='fdn' AND data->>'eligible'='true'`)).rows[0];
  assert.deepEqual(fdn,{printings:771,names:517});
  const banner = (await db.query(`SELECT count(*)::int AS total FROM web_cards WHERE data->>'setCode'='vma'
    AND data->>'eligible'='false' AND data->>'imageUri' LIKE 'https://cards.scryfall.io/%'`)).rows[0];
  assert.equal(banner.total,6);
  // Only web_cards is persistent. Every player, reward, receipt and ownership
  // record below uses private temporary tables and the final rollback.
  await db.query("CREATE TEMP TABLE web_players(id uuid PRIMARY KEY)");
  const schema = (await readFile(new URL("./league.sql",import.meta.url),"utf8"))
    .replace("card_id text NOT NULL REFERENCES web_cards","card_id text NOT NULL")
    .replaceAll("CREATE TABLE IF NOT EXISTS","CREATE TEMP TABLE");
  await db.query(schema);
  const player = randomUUID();
  await db.query("INSERT INTO web_players VALUES ($1)",[player]);
  const args = {count:1,requestId:"catalog-real-pack"};
  const pack = await leagueCommand(db,player,"open_next_boosters",args);
  assert.equal(pack.cards.length,15);
  assert.equal(pack.setCode,"fdn");
  assert.equal(pack.cards.filter(c => c.rarity === "common").length,10);
  assert.equal(pack.cards.filter(c => c.rarity === "uncommon").length,4);
  assert.equal(pack.cards.filter(c => c.rarity === "rare" || c.rarity === "mythic").length,1);
  assert.ok(pack.cards.every(c => c.forgeSetCode === "FDN" && c.owned === 1 && c.oracleOwned === 1 && c.forgeName));
  assert.deepEqual(await leagueCommand(db,player,"resolve_booster_opening",args),pack);
});
