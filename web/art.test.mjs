import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import pg from "pg";
import { cachedArt, imageLocation, serveArt } from "./art.mjs";

test("serves only the requested Scryfall cache face and recognized image formats", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "league-web-art-"));
  try {
    const id = randomUUID(), card = path.join(directory,id);
    await mkdir(card);
    const image = Buffer.concat([Buffer.from([0xff,0xd8,0xff]),Buffer.alloc(24)]);
    await writeFile(path.join(card,"front.img"),image);
    await writeFile(path.join(card,"back.img"),"This is not an image");
    const cached = await cachedArt(directory,id,"front");
    assert.equal(cached.type,"image/jpeg");
    assert.deepEqual(cached.bytes,image);
    assert.ok(cached.etag.includes(id));
    assert.equal(await cachedArt(directory,id,"back"),null);
    assert.equal(await cachedArt(directory,id,"../front"),null);
    assert.equal(await cachedArt(directory,"../" + id,"front"),null);
  } finally {
    await rm(directory,{ recursive:true, force:true });
  }
});

test("catalog redirects are limited to HTTPS artwork on the exact image host", () => {
  assert.equal(imageLocation("https://cards.scryfall.io/normal/front/a.jpg?1"),"https://cards.scryfall.io/normal/front/a.jpg?1");
  for (const value of ["https://cards.scryfall.io.example/a", "http://cards.scryfall.io/a", "https://u@cards.scryfall.io/a", "https://cards.scryfall.io:8080/a", "/file", null]) {
    assert.equal(imageLocation(value),null);
  }
});

test("the reported Foundations Goblin uses its token printing and never falls back to a regular card", async t => {
  const art = "https://cards.scryfall.io/normal/front/token.jpg";
  const upstream = t.mock.method(globalThis, "fetch", async url => {
    if (url.endsWith("/tfdn/18")) return Response.json({ name: "Goblin", layout: "token", image_uris: { normal: art } });
    return Response.json({ name: "Goblin", layout: "normal", image_uris: { normal: art } });
  });
  const db = { query() { throw Error("Tokens must not hit the ordinary card catalog."); } };
  const request = async query => {
    const res = { writeHead(status, headers) { this.status = status; this.headers = headers; }, end() {} };
    await serveArt(new URL("http://localhost/api/art?" + new URLSearchParams({ token: "1", ...query })), res, db);
    return res;
  };
  const goblin = { name: "Goblin Token", set: "FDN", number: "18" };
  assert.equal((await request(goblin)).headers.Location, art);
  assert.equal((await request({ ...goblin, name: "Goblin", token: "printing" })).headers.Location, art);
  assert.equal((await request({ ...goblin, name: "Elf Token" })).status, 404);
  assert.equal(upstream.mock.callCount(), 1);
  assert.equal(upstream.mock.calls[0].arguments[0], "https://api.scryfall.com/cards/tfdn/18");
  assert.equal((await request({ ...goblin, number: "99" })).status, 404);
  assert.equal((await request({ name: "Goblin Token" })).status, 404);
});

test("art requests resolve exact PostgreSQL printing and face across Forge aliases", {
  skip: !process.env.DATABASE_URL && !process.env.PGDATABASE,
}, async () => {
  const client = new pg.Client(process.env.DATABASE_URL ? {connectionString:process.env.DATABASE_URL} : {});
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("CREATE TEMP TABLE web_cards(id text PRIMARY KEY,data jsonb NOT NULL) ON COMMIT DROP");
    const id = randomUUID();
    const front = "https://cards.scryfall.io/normal/front/1.jpg";
    const back = "https://cards.scryfall.io/normal/back/1.jpg";
    await client.query("INSERT INTO web_cards VALUES($1,$2)", [id,{
      name:"Day // Night",setCode:"tst",forgeSetCode:"TST2",collectorNumber:"1",forgeCollectorNumber:"1a",
      forgeName:"Day",imageUri:front,backImageUri:back,
    }]);
    const request = async query => {
      const res = { writeHead(status,headers) {this.status=status;this.headers=headers;}, end() {} };
      await serveArt(new URL("http://localhost/api/art?" + new URLSearchParams(query)),res,client);
      return res;
    };
    assert.equal((await request({name:"Day",set:"TST2",number:"1a"})).headers.Location,front);
    assert.equal((await request({name:"Night",set:"TST2",number:"1a"})).headers.Location,back);
    assert.equal((await request({id,face:"back"})).headers.Location,back);
    assert.equal((await request({name:"Day",set:"tst",number:"2"})).status,404);
  } finally {
    await client.query("ROLLBACK").finally(() => client.end());
  }
});
