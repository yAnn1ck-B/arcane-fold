import { database } from "@/services/database";
import { validateMatch } from "./engine";
import { exportForgeManual } from "./forge-match";
import { newSession, restoreSession } from "./session";
import type { Match } from "./types";

interface Printing {
  original: string;
  id: string;
  oracleId: string;
  name: string;
  imageUri: string | null;
  backImageUri: string | null;
  setName: string;
}

// Attach local artwork only when the catalog identifies the same printing.
// Forge's own metadata remains usable for cards outside the league catalog.
async function linkPrintings(match: Match) {
  const cards = Object.values(match.catalog);
  if (!cards.length) return;
  const db = await database();
  const rows = await db.select<Printing[]>(
    `
    SELECT json_extract(j.value, '$.id') AS original, c.id, c.oracle_id AS oracleId,
           c.name, c.set_name AS setName, c.image_uri AS imageUri, c.back_image_uri AS backImageUri
    FROM json_each(?) j JOIN cards c
      ON c.set_code = lower(json_extract(j.value, '$.setCode'))
     AND c.collector_number = json_extract(j.value, '$.collectorNumber') COLLATE NOCASE
    WHERE c.name = json_extract(j.value, '$.name') COLLATE NOCASE
       OR substr(c.name, 1, instr(c.name, ' // ') - 1) = json_extract(j.value, '$.name') COLLATE NOCASE
    GROUP BY j.key HAVING COUNT(*) = 1
  `,
    [
      JSON.stringify(
        cards.map(({ id, setCode, collectorNumber, name }) => ({
          id,
          setCode,
          collectorNumber,
          name,
        })),
      ),
    ],
  );
  const ids = new Map<string, string>();
  for (const { original, ...printing } of rows) {
    match.catalog[printing.id] = { ...match.catalog[original], ...printing };
    ids.set(original, printing.id);
  }
  for (const [original, mapped] of ids)
    if (mapped !== original) delete match.catalog[original];
  for (const piece of Object.values(match.pieces))
    if (piece.printing)
      piece.printing = ids.get(piece.printing) ?? piece.printing;
  for (const entry of match.stack)
    if (entry.copyPrinting)
      entry.copyPrinting = ids.get(entry.copyPrinting) ?? entry.copyPrinting;
}

export async function prepareForgeHandoff(
  id: string,
  revision: number,
) {
  const { match, history } = await exportForgeManual(id, revision);
  if (!validateMatch(match) || !Array.isArray(history))
    throw new Error("This Forge position could not be read as a manual game.");
  // The complete position already contains Forge's card records. A temporarily
  // unavailable artwork catalog must not prevent the player from taking over.
  await linkPrintings(match).catch(() => {});
  return restoreSession(newSession(match, history).saved);
}
