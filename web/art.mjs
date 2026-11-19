import { open, realpath } from "node:fs/promises";
import path from "node:path";
import { pool } from "./db.mjs";

const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const maxBytes = 10 * 1024 * 1024;

export function imageLocation(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.origin !== "https://cards.scryfall.io" || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

function mime(bytes) {
  if (bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return "image/jpeg";
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

// The configured cache is optional and read-only. Use only UUID/face entries and require
// the real path to have those exact relative components, including across symlinks.
export async function cachedArt(cache, id, face) {
  if (!cache || !uuid.test(id) || !["front", "back"].includes(face)) return null;
  let file;
  try {
    const root = await realpath(cache);
    const expected = path.join(id, face + ".img");
    const actual = await realpath(path.join(root, expected));
    if (path.relative(root, actual) !== expected) return null;
    file = await open(actual, "r");
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < 12 || stat.size > maxBytes) return null;
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) return null;
      offset += bytesRead;
    }
    const type = mime(bytes);
    return type ? { bytes, type, etag: `"${id}-${face}-${stat.size}-${Math.floor(stat.mtimeMs)}"` } : null;
  } catch {
    return null;
  } finally {
    await file?.close();
  }
}

function unavailable(res, status = 404) {
  res.writeHead(status, { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" });
  res.end("Artwork unavailable.");
}

function redirect(res, destination) {
  res.writeHead(302, { Location: destination, "Cache-Control": "public, max-age=3600", "Referrer-Policy": "no-referrer" });
  res.end();
}

export async function serveArt(url, res, db = pool) {
  const params = url.searchParams;
  const id = params.get("id");
  const name = (params.get("name") ?? "").trim();
  const set = (params.get("set") ?? "").toLowerCase();
  const number = params.get("number") ?? "";
  const face = params.get("face") ?? "front";
  if (!["front","back"].includes(face) || (!id && !name) || (id && !uuid.test(id))
    || name.length > 250 || set.length > 16 || number.length > 32 || /[\p{Cc}]/u.test(name + set + number)) {
    return unavailable(res, 400);
  }
  let row;
  if (id) {
    ({ rows: [row] } = await db.query("SELECT id,data FROM web_cards WHERE id=$1", [id]));
  } else {
    ({ rows: [row] } = await db.query(`SELECT id,data FROM web_cards
      WHERE (lower(data->>'name')=lower($1) OR lower(data->>'forgeName')=lower($1)
        OR lower($1)=ANY(string_to_array(lower(data->>'name'), ' // ')))
        AND ($2='' OR $2 IN (data->>'setCode',lower(data->>'forgeSetCode')))
        AND ($3='' OR $3 IN (data->>'collectorNumber',data->>'forgeCollectorNumber'))
      ORDER BY (data->>'setCode'='fdn') DESC, id LIMIT 1`, [name, set, number]));
  }
  if (!row) {
    // Forge-generated tokens often have no Scryfall ID or collector number.
    // The table can still display its game-supplied name and rules if there is no image.
    if (!id && (params.get("token") === "1" || / Token$/i.test(name))) {
      const token = new URL("https://api.scryfall.com/cards/named");
      token.search = new URLSearchParams({ exact: name.replace(/ Token$/i, ""), format: "image", version: "normal" });
      return redirect(res, token.href);
    }
    return unavailable(res);
  }
  const backName = row.data.name.split(" // ")[1];
  const lookupFace = !id && backName && name.toLowerCase() === backName.toLowerCase() && row.data.backImageUri ? "back" : face;
  const cached = await cachedArt(process.env.WEB_CARD_IMAGE_CACHE, row.id, lookupFace);
  if (cached) {
    const headers = { "Cache-Control": "public, max-age=86400", "ETag": cached.etag, "X-Content-Type-Options": "nosniff" };
    if (res.req?.headers["if-none-match"] === cached.etag) {
      res.writeHead(304, headers);
      return res.end();
    }
    res.writeHead(200, { ...headers, "Content-Type": cached.type, "Content-Length": cached.bytes.length });
    return res.end(cached.bytes);
  }
  const remote = imageLocation(lookupFace === "front" ? row.data.imageUri : row.data.backImageUri);
  if (remote) return redirect(res, remote);
  return unavailable(res);
}
