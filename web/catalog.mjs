import { spawn } from "node:child_process";
import { once } from "node:events";
import { createReadStream } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { rules } from "./league.mjs";
import { pool, transaction } from "./db.mjs";

const banners = new Set(["Black Lotus","Mox Pearl","Mox Sapphire","Mox Jet","Mox Ruby","Mox Emerald"]);
const sets = new Set([...rules.enabledSets,...rules.expansionSchedule.map(entry => entry.code),
  ...rules.autoUnlock.setCodes,"VMA"].map(code => code.toLowerCase()));
// Forge CardEdition.EditionSectionWithCollectorNumbers, also used by the desktop deck exporter.
const printSections = new Set(["cards","special slot","precon product","borderless","etched","showcase","full art",
  "extended art","alternate art","retro frame","buy a box","promo","prerelease promo","bundle","box topper",
  "jumpstart","rebalanced","eternal","conjured","scheme","printsheets"]);
const mainTypes = new Set(["artifact","battle","creature","enchantment","instant","kindred","land","planeswalker","sorcery","tribal"]);
const excludedLayouts = new Set(["token","double_faced_token","emblem","art_series","planar","scheme","vanguard","augment","host"]);
const lower = text => String(text ?? "").toLowerCase();

export function parseEdition(source) {
  const metadata = {}, entries = [];
  let section = "";
  for (const row of source.split(/\r?\n/)) {
    const line = row.trim();
    if (line.startsWith("[") && line.endsWith("]")) section = lower(line.slice(1,-1));
    else if (section === "metadata") {
      const pos = line.indexOf("=");
      if (pos > 0) metadata[lower(line.slice(0,pos).trim())] = line.slice(pos+1).trim();
    } else if (printSections.has(section) && line && !line.startsWith("#")) {
      const match = /^([^\s[\]|@$=]+)\s+[SCURML]\s+(.+)$/.exec(line);
      if (!match || !/[a-z0-9]/i.test(match[1])) continue;
      const name = match[2].split(/ [@$]/,1)[0].trim();
      if (name && !name.includes("|")) entries.push({number:match[1],name});
    }
  }
  return { code: metadata.code, scryfall: lower(metadata.scryfallcode ?? metadata.code), entries };
}

async function editions(install) {
  if (!install) throw new Error("Pass --forge <Forge 2.0.13 installation> or set FORGE_INSTALL.");
  const dir = join(install,"res","editions");
  const index = new Map();
  for (const file of await readdir(dir)) {
    if (!file.endsWith(".txt")) continue;
    const edition = parseEdition(await readFile(join(dir,file),"utf8"));
    if (!sets.has(edition.scryfall)) continue;
    for (const entry of edition.entries) {
      if (edition.scryfall === "vma" && !banners.has(entry.name)) continue;
      const key = edition.scryfall + "/" + lower(entry.number);
      if (!index.has(key)) index.set(key, []);
      index.get(key).push({ ...entry, code: edition.code });
    }
  }
  const found = new Set([...index.keys()].map(key => key.split("/")[0]));
  const missing = [...sets].filter(code => !found.has(code));
  if (missing.length) throw new Error("Missing required Forge editions: " + missing.join(", "));
  return index;
}

function image(source) {
  const url = source?.image_uris?.normal ?? source?.image_uris?.jpeg ?? source?.image_uris?.png;
  if (!url) return null;
  const parsed = new URL(url);
  return parsed.protocol === "https:" && ["cards.scryfall.io","img.scryfall.com"].includes(parsed.hostname) ? parsed.href : null;
}
export function normalize(record, index) {
  const setCode = lower(record.set);
  if (!sets.has(setCode) || (record.object && record.object !== "card") || record.lang && record.lang !== "en") return null;
  if (setCode === "vma" && !banners.has(record.name)) return null;
  const candidates = index.get(setCode + "/" + lower(record.collector_number));
  if (!candidates?.length) return null;
  const faces = record.card_faces ?? [];
  const name = lower(record.name);
  const printing = candidates.find(entry => lower(entry.name) === name) ??
    candidates.find(entry => lower(entry.name) === name.split(" // ")[0]);
  if (!printing) return null;
  const field = key => record[key] || faces.map(face => face[key]).filter(Boolean).join(" // ");
  const typeLine = field("type_line");
  const types = typeLine.split(" // ").flatMap(face => lower(face.split("—")[0]).split(/\s+/));
  const manaCost = field("mana_cost");
  const cmc = record.cmc ?? 0;
  const eligible = !record.digital && !record.oversized && (!record.games || record.games.includes("paper")) &&
    ["white","black","borderless"].includes(lower(record.border_color || "black")) &&
    !["acorn","heart"].includes(lower(record.security_stamp)) &&
    !["funny","memorabilia","minigame","token","art_series"].includes(lower(record.set_type)) &&
    !excludedLayouts.has(lower(record.layout)) && Number.isInteger(cmc) && !manaCost.includes("{H") &&
    !/[./½¼¾]/.test(String(record.power ?? "") + String(record.toughness ?? "")) &&
    !/token|emblem/i.test(typeLine) && (!typeLine || types.some(type => mainTypes.has(type)));
  if (!eligible && setCode !== "vma") return null;
  if (!record.id || !record.name || !["common","uncommon","rare","mythic","bonus","special"].includes(record.rarity)) {
    throw new Error("Invalid Scryfall record for " + setCode + "/" + record.collector_number);
  }
  return {
    id: record.id, oracleId: record.oracle_id || faces[0]?.oracle_id || record.id, name: record.name,
    setCode, setName: record.set_name, collectorNumber: String(record.collector_number),
    forgeSetCode: printing.code, forgeName: printing.name, forgeCollectorNumber: printing.number,
    rarity: record.rarity, manaCost, cmc, typeLine, oracleText: field("oracle_text"),
    colors: [...new Set(record.colors ?? faces.flatMap(face => face.colors ?? []))].sort(),
    producedMana: record.produced_mana ?? [], imageUri: image(record) ?? image(faces[0]), backImageUri: image(faces[1]),
    booster: eligible && record.booster !== false, promo: record.promo === true, digital: record.digital === true,
    eligible: setCode !== "vma" && eligible, owned: 0, oracleOwned: 0,
  };
}

async function* jsonLines(input) {
  for await (const line of createInterface({input,crlfDelay:Infinity})) {
    if (line.trim()) yield JSON.parse(line);
  }
}
async function* snapshot(path) {
  // Do not give the read-only helper the web server's database credentials.
  const env = { PATH:process.env.PATH, PYTHONUTF8:"1" };
  for (const key of ["SystemRoot","WINDIR","TEMP","TMP","LANG"]) if (process.env[key]) env[key] = process.env[key];
  const child = spawn(process.env.PYTHON || "python", ["-I",fileURLToPath(new URL("./catalog-snapshot.py",import.meta.url)),
    path,...sets], { env,windowsHide:true,stdio:["ignore","pipe","inherit"] });
  const done = once(child,"close").then(([code]) => ({ code }), error => ({ error }));
  try {
    yield* jsonLines(child.stdout);
    const result = await done;
    if (result.error) throw new Error("Cannot start Python to read the public catalog snapshot.", { cause:result.error });
    if (result.code !== 0) throw new Error("The public card-metadata reader failed.");
  } finally {
    if (child.exitCode === null && child.pid) child.kill();
  }
}
async function* scryfall(index) {
  const refs = [...index.keys()].map(key => {
    const [set,collector_number] = key.split("/");
    return { set,collector_number };
  });
  for (let i = 0; i < refs.length; i += 75) {
    if (i) await delay(120);
    let batch;
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch("https://api.scryfall.com/cards/collection", {
        method: "POST", headers: { Accept:"application/json","Content-Type":"application/json",
          "User-Agent":"Arcane-Fold-Web/0.4 (card catalog)" },
        body: JSON.stringify({identifiers:refs.slice(i,i+75)}), signal: AbortSignal.timeout(45000),
      });
      if (res.ok) { batch = await res.json(); break; }
      if (res.status !== 429 && res.status < 500) throw new Error("Scryfall returned HTTP " + res.status);
      const retryAfter = Number(res.headers.get("retry-after")) || 0;
      if (retryAfter > 60) throw new Error("Scryfall requested a longer cooldown. Retry the catalog import later.");
      await delay(Math.max(1000 * (attempt + 1), retryAfter * 1000));
    }
    if (!Array.isArray(batch?.data)) throw new Error("Scryfall could not provide this printing batch.");
    yield* batch.data;
  }
}

async function run() {
  const {values} = parseArgs({ options: { forge:{type:"string"},sqlite:{type:"string"},jsonl:{type:"string"} } });
  if (values.sqlite && values.jsonl) throw new Error("Choose one public card metadata source.");
  const index = await editions(values.forge || process.env.FORGE_INSTALL);
  const records = values.sqlite ? snapshot(values.sqlite) : values.jsonl ? jsonLines(createReadStream(values.jsonl)) : scryfall(index);
  const cards = new Map();
  for await (const record of records) {
    const card = normalize(record,index);
    if (card) cards.set(card.id,card);
  }
  const stored = [...cards.values()];
  const counts = Object.fromEntries([...sets].map(code => [code,stored.filter(card => card.setCode === code).length]));
  const numbers = new Set(stored.filter(card => card.setCode === "fdn").map(card => "fdn/" + lower(card.collectorNumber)));
  if ([...index.keys()].some(key => key.startsWith("fdn/") && !numbers.has(key))) {
    throw new Error("The metadata source is missing Foundations printings from this Forge installation.");
  }
  const absent = Object.keys(counts).filter(code => !counts[code]);
  if (absent.length) throw new Error("The metadata source is missing editions: " + absent.join(", "));
  if (counts.vma !== banners.size) throw new Error("The catalog is missing VMA banner artwork.");
  await transaction(async db => {
    for (let i = 0; i < stored.length; i += 250) {
      await db.query(`INSERT INTO web_cards(id,data) SELECT data->>'id',data FROM jsonb_array_elements($1::jsonb) AS input(data)
        ON CONFLICT(id) DO UPDATE SET data=EXCLUDED.data WHERE web_cards.data IS DISTINCT FROM EXCLUDED.data`,
      [JSON.stringify(stored.slice(i,i + 250))]);
    }
  });
  console.log("Imported exact Forge printings by Scryfall set",counts);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => pool.end());
}
