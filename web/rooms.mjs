import { randomBytes, randomUUID } from 'node:crypto';
import { pool, transaction } from './db.mjs';
import { createGame } from './forge.mjs';
import { getPlayableDeck, playableDecks } from './league-decks.mjs';

export function reject(status, message) {
  throw Object.assign(new Error(message), { status });
}
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const engines = new Map();
const seatFor = (room, player) => room.host === player ? 'player' : 'opponent';
function summary(room, player) {
  return { id: room.id, status: room.status, label: room.label, revision: room.revision,
    seat: seatFor(room, player), ...(room.host === player && !room.guest ? { inviteCode: room.invite_code } : {}) };
}
export async function lobby(player) {
  const { rows } = await pool.query('SELECT id,status,label,revision,host,guest,invite_code FROM web_rooms WHERE host=$1 OR guest=$1 ORDER BY updated_at DESC', [player]);
  return { rooms: rows.map(room => summary(room, player)), decks: await playableDecks(pool, player) };
}
export async function createRoom(player, deckId) {
  const deck = await getPlayableDeck(pool, player, deckId);
  if (!deck) reject(400, 'Choose a playable deck.');
  const roomId = randomUUID();
  const invite = randomBytes(12).toString('hex').toUpperCase();
  await pool.query('INSERT INTO web_rooms(id,host,host_deck,invite_code,seed,label) VALUES($1,$2,$3,$4,$5,$6)',
    [roomId, player, deck.text, invite, randomBytes(8).readBigInt64BE().toString(), deck.name]);
  return { id: roomId, inviteCode: invite };
}
async function roomRow(db, id, player, lock = false) {
  if (!uuid.test(id)) reject(404, 'Table unavailable.');
  const columns = lock ? '*' : 'id,status,label,revision,host,guest,invite_code';
  const { rows: [row] } = await db.query('SELECT ' + columns + ' FROM web_rooms WHERE id=$1 AND (host=$2 OR guest=$2)' + (lock ? ' FOR UPDATE' : ''), [id, player]);
  if (!row) reject(404, 'Table unavailable.');
  return row;
}
export async function savePosition(db, room, engine) {
  room.revision++;
  const p = engine.view('player'), o = engine.view('opponent');
  p.revision = o.revision = room.revision;
  room.status = p.stage === 'finished' ? 'finished' : 'playing';
  const checkpoint = engine.checkpoint();
  const cursor = { version: checkpoint.version, initial: checkpoint.initial, moveCount: checkpoint.moves.length,
    lastMoveDigest: checkpoint.moves.at(-1)?.after ?? null, pending: checkpoint.pending };
  await db.query('INSERT INTO web_positions(room_id,revision,player,opponent,replay_cursor) VALUES($1,$2,$3,$4,$5)',
    [room.id, room.revision, p, o, cursor]);
  await db.query('UPDATE web_rooms SET checkpoint=$2,status=$3,revision=$4,updated_at=now() WHERE id=$1',
    [room.id, checkpoint, room.status, room.revision]);
  return { player: p, opponent: o };
}
// The database row lock serializes durable moves across requests and server instances.
// Cached engines are disposable. A failed commit invalidates the speculative engine.
async function mutate(work) {
  let active;
  try {
    return await transaction(db => work(db, (room, engine) => {
      active = { id: room.id, engine, revision: room.revision + 1, touched: Date.now(), busy: true };
      engines.set(room.id, active);
    }));
  } catch (error) {
    if (active && engines.get(active.id) === active) {
      engines.delete(active.id);
      await active.engine.close();
    }
    throw error;
  } finally {
    if (active && engines.get(active.id) === active) active.busy = false;
  }
}
export async function joinRoom(player, code, deckId) {
  if (typeof code !== 'string' || !/^[A-F0-9]{24}$/i.test(code.trim())) reject(404, 'Invite code not found.');
  return mutate(async (db, track) => {
    const { rows: [room] } = await db.query('SELECT * FROM web_rooms WHERE invite_code=$1 FOR UPDATE', [code.trim().toUpperCase()]);
    if (!room) reject(404, 'Invite code not found.');
    if (room.host === player) reject(409, 'Open this invitation in a different browser session.');
    if (room.guest === player) return { id: room.id };
    if (room.guest) reject(409, 'Both seats are taken.');
    const deck = await getPlayableDeck(db, player, deckId);
    if (!deck) reject(400, 'Choose a playable deck.');
    const engine = await createGame({ decks: [room.host_deck, deck.text], seed: room.seed });
    track(room, engine);
    await db.query("UPDATE web_rooms SET guest=$2,guest_deck=$3,label=label || ' vs. ' || $4 WHERE id=$1", [room.id, player, deck.text, deck.name]);
    await savePosition(db, room, engine);
    return { id: room.id };
  });
}
export async function roomView(id, player) {
  return readSeatPosition(pool, id, player);
}
export async function readSeatPosition(db, id, player) {
  const room = await roomRow(db, id, player);
  const seat = seatFor(room, player);
  const { rows: [position] } = await db.query('SELECT ' + seat + ' AS state FROM web_positions WHERE room_id=$1 AND revision=$2', [id, room.revision]);
  return { ...summary(room, player), state: position?.state ?? null };
}
export async function move(id, player, body) {
  return mutate(async (db, track) => {
    const room = await roomRow(db, id, player, true);
    if (room.status !== 'playing' || room.revision !== body.revision) reject(409, 'The table changed. Refresh to see the current decision.');
    const seat = seatFor(room, player);
    const stop = Object.hasOwn(body, 'stop');
    if (stop === Object.hasOwn(body, 'actionId') || typeof (stop ? body.stop : body.actionId) !== 'string') reject(400, 'Choose one available action.');
    let cached = engines.get(id);
    if (cached && cached.revision !== room.revision) {
      engines.delete(id);
      await cached.engine.close();
      cached = null;
    }
    const engine = cached?.engine ?? await createGame({ decks: [room.host_deck, room.guest_deck], seed: room.seed, checkpoint: room.checkpoint });
    track(room, engine);
    try {
      if (stop) await engine.stop(seat, body.stop);
      else await engine.act(seat, body.actionId);
    } catch (error) {
      if (/unavailable to this seat|invalid priority stop/i.test(error.message)) reject(409, error.message);
      throw error;
    }
    const states = await savePosition(db, room, engine);
    return { ...summary(room, player), state: states[seat] };
  });
}
export async function report(id, player, body) {
  return transaction(db => recordSeatReport(db, id, player, body));
}

function reportDisplay(client) {
  const { appVersion, capturedAt, visibleDialog, error, visibleControls = [] } = client;
  if (typeof appVersion !== 'string' || !appVersion.length || appVersion.length > 80 ||
      typeof capturedAt !== 'string' || capturedAt.length > 40 || !Number.isFinite(Date.parse(capturedAt)) ||
      (visibleDialog != null && typeof visibleDialog !== 'string') ||
      (error != null && typeof error !== 'string') || !Array.isArray(visibleControls)) {
    reject(400, 'Invalid report metadata.');
  }
  let truncated = client.visibleControlsTruncated === true || visibleControls.length > 256;
  const controls = visibleControls.slice(0,256).map(control => {
    if (typeof control?.label !== 'string' || (control.disabled != null && typeof control.disabled !== 'boolean')) {
      reject(400, 'Invalid report control.');
    }
    truncated ||= control.label.length > 512;
    return {label: control.label.slice(0,512), disabled: control.disabled === true};
  });
  return { appVersion, capturedAt, visibleDialog: visibleDialog?.slice(0,256), error: error?.slice(0,2000),
    visibleControls: controls, visibleControlsTruncated: truncated };
}

export async function recordSeatReport(db, id, player, body) {
  const room = await roomRow(db, id, player);
  const seat = seatFor(room, player);
  const { revision, details = '', report: client } = body;
  if (!Number.isInteger(revision) || !uuid.test(client?.id ?? '') || typeof details !== 'string' || details.length > 1000) reject(400, 'Invalid issue report.');
  const display = reportDisplay(client);
  const { rows: [position] } = await db.query('SELECT ' + seat + ' AS state FROM web_positions WHERE room_id=$1 AND revision=$2', [id, revision]);
  if (!position) reject(409, 'The reported position is unavailable.');
  // The authoritative board and log come from the exact historical revision, even
  // if the other player advanced while the reporter was writing their note.
  const { choices, history, ...board } = position.state;
  const snapshot = { schemaVersion: 1, mode: 'forge', engineVersion: 'Forge Desktop 2.0.13',
    matchId: id, revision, viewer: seat, board, actions: choices, history, ...display };
  const result = await db.query(`INSERT INTO web_reports(id,reporter,room_id,revision,seat,details,snapshot)
    VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO UPDATE SET id=EXCLUDED.id
    WHERE web_reports.reporter=EXCLUDED.reporter AND web_reports.room_id=EXCLUDED.room_id
      AND web_reports.revision=EXCLUDED.revision AND web_reports.details=EXCLUDED.details AND web_reports.snapshot=EXCLUDED.snapshot`,
    [client.id, player, id, revision, seat, details.trim(), snapshot]);
  if (!result.rowCount) reject(409, 'That report ID was already used.');
  return { id: client.id };
}
const sweep = setInterval(() => {
  for (const [id, cached] of engines) if (!cached.busy && Date.now() - cached.touched > 5 * 60_000) {
    engines.delete(id);
    void cached.engine.close().catch(() => {});
  }
}, 60_000);
sweep.unref();
export async function closeGames() {
  clearInterval(sweep);
  await Promise.allSettled([...engines.values()].map(entry => entry.engine.close()));
}
