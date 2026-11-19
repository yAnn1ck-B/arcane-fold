import { randomBytes, randomUUID } from 'node:crypto';
import { pool, transaction } from './db.mjs';
import { createGame } from './forge.mjs';
import { historySteps, retirePositions, rewindForge } from './room-history.mjs';
import { createManual, manualView, applyManual } from './manual.mjs';
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
  const columns = lock ? '*' : 'id,status,label,revision,host,guest,invite_code,mode,pending_request,control_version,last_resolution';
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

async function saveManualPosition(db, room, checkpoint) {
  const p = manualView(checkpoint, 'player');
  const o = manualView(checkpoint, 'opponent');
  room.revision++;
  room.mode = 'manual';
  room.status = 'playing';
  await db.query(`INSERT INTO web_positions(room_id,revision,mode,player,opponent,manual_checkpoint)
      VALUES($1,$2,'manual',$3,$4,$5)`, [room.id, room.revision, p, o, checkpoint]);
  await db.query(`UPDATE web_rooms SET mode='manual',status='playing',revision=$2,checkpoint=$3,updated_at=now()
      WHERE id=$1`, [room.id, room.revision, checkpoint]);
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
  if (!uuid.test(id)) reject(404,'Table unavailable.');
  // Read consent, lineage and the seat projection in the same MVCC snapshot. A
  // rewind can retire the old timeline while a browser is polling.
  const { rows:[room] } = await db.query(`SELECT r.id,r.status,r.label,r.revision,r.host,r.guest,r.invite_code,
    r.mode,r.pending_request,r.control_version,r.last_resolution,
    CASE WHEN r.host=$2 THEN p.player ELSE p.opponent END AS state,
    EXISTS(SELECT 1 FROM web_positions prior WHERE prior.room_id=r.id AND prior.mode=r.mode
      AND prior.retired_at IS NULL AND prior.revision<r.revision) AS undoable
    FROM web_rooms r LEFT JOIN web_positions p ON p.room_id=r.id AND p.revision=r.revision
    WHERE r.id=$1 AND (r.host=$2 OR r.guest=$2)`,[id,player]);
  if (!room) reject(404,'Table unavailable.');
  return { ...summary(room, player), mode:room.mode, pendingRequest:room.pending_request, controlVersion:room.control_version,
    lastResolution:room.last_resolution, undoAvailable:room.undoable,
    state:room.mode === 'forge' ? room.state : null, manualState:room.mode === 'manual' ? room.state : null };
}

export function roomHistory(id, player) {
  return transaction(async db => {
    await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const room = await roomRow(db,id,player);
    return {revision:room.revision, steps:await historySteps(db,room,seatFor(room,player))};
  });
}

async function forgetEngine(id) {
  const previous = engines.get(id);
  if (!previous) return;
  engines.delete(id);
  await previous.engine.close();
}

async function currentEngine(room) {
  const cached = engines.get(room.id);
  if (cached?.revision === room.revision) return cached.engine;
  await forgetEngine(room.id);
  return createGame({decks:[room.host_deck,room.guest_deck],seed:room.seed,checkpoint:room.checkpoint});
}
export function move(id, player, body) {
  return mutate((db, track) => applyMove(db, id, player, body, track));
}

export async function applyMove(db, id, player, body, track) {
  const room = await roomRow(db, id, player, true);
  if (room.status !== 'playing' || room.revision !== body.revision) reject(409, 'The table changed. Refresh to see the current decision.');
  if (room.pending_request) reject(409, 'Respond to the pending table request before continuing.');
  if (room.control_version !== (body.controlVersion ?? 0)) reject(409,'A table request changed. Review the position and choose your action again.');
  const seat = seatFor(room, player);
  if (room.mode === 'manual') {
    if (!body.manualAction || Object.hasOwn(body,'actionId') || Object.hasOwn(body,'stop')) reject(400,'Choose a manual action.');
    await saveManualPosition(db,room,await applyManual(room.checkpoint,seat,body.manualAction));
    return readSeatPosition(db,id,player);
  }
  const stop = Object.hasOwn(body, 'stop');
  if (stop === Object.hasOwn(body, 'actionId') || typeof (stop ? body.stop : body.actionId) !== 'string') reject(400, 'Choose one available action.');
  const engine = await currentEngine(room);
  track(room, engine);
  try {
    if (stop) await engine.stop(seat, body.stop);
    else await engine.act(seat, body.actionId);
  } catch (error) {
    if (/unavailable to this seat|invalid priority stop/i.test(error.message)) reject(409, error.message);
    throw error;
  }
  await savePosition(db, room, engine);
  return readSeatPosition(db,id,player);
}

export function tableRequest(id, player, body) {
  return mutate((db, track) => changeRequest(db, id, player, body, track));
}

export async function changeRequest(db, id, player, body, track) {
  const room = await roomRow(db,id,player,true);
  const seat = seatFor(room,player);
  if (!room.guest || room.revision !== body.revision || room.control_version !== (body.controlVersion ?? 0)) {
    reject(409, 'The table changed. Review the current position.');
  }
  const pending = room.pending_request;
  if (Object.hasOwn(body,'decision')) {
    if (!pending || pending.id !== body.requestId) reject(409, 'This request is no longer pending.');
    const decision = body.decision;
    if (!['accept','decline','cancel'].includes(decision)) reject(400,'Choose a response.');
    if ((decision === 'cancel') !== (pending.requester === seat)) reject(403,'This response belongs to the other seat.');
    if (decision === 'accept') {
      if (pending.kind === 'manual') {
        const engine = await currentEngine(room);
        // Own the engine until export finishes, including across an idle sweep.
        if (engines.get(id)?.engine === engine) engines.delete(id);
        try {
          const exported = await engine.exportManual();
          const checkpoint = createManual(exported);
          await retirePositions(db,room,1);
          await saveManualPosition(db,room,checkpoint);
        } finally {
          await engine.close();
        }
      } else {
        const { rows:[position] } = await db.query(`SELECT * FROM web_positions WHERE room_id=$1 AND revision=$2
          AND mode=$3 AND retired_at IS NULL AND revision<$4`,[id,pending.targetRevision,room.mode,room.revision]);
        if (!position) reject(409,'That position is no longer in the current game history.');
        if (room.mode === 'manual') {
          await retirePositions(db,room,position.revision);
          await saveManualPosition(db,room,position.manual_checkpoint);
        } else {
          await forgetEngine(id);
          const restored = await rewindForge(room,position);
          track(room,restored);
          await retirePositions(db,room,position.revision);
          await savePosition(db,room,restored);
        }
      }
    }
    const resolution = { requestId:pending.id,kind:pending.kind,requester:pending.requester,responder:seat,
      decision, ...(pending.targetLabel ? { targetLabel:pending.targetLabel } : {}) };
    await db.query(`UPDATE web_rooms SET pending_request=NULL,control_version=control_version+1,
      last_resolution=$2,updated_at=now() WHERE id=$1`,[id,resolution]);
  } else {
    if (pending) reject(409,'There is already a request at this table.');
    const request = {id:randomUUID(),kind:body.kind,requester:seat};
    if (body.kind === 'manual') {
      if (room.mode !== 'forge' || room.status !== 'playing') reject(409,'Manual play can start during a Forge game.');
    } else if (body.kind === 'undo') {
      const step = (await historySteps(db,room)).find(step => step.revision === body.targetRevision);
      if (!step) reject(409,'Choose an earlier position from the current game history.');
      request.targetRevision = step.revision;
      request.targetLabel = step.label;
    } else reject(400,'Unknown table request.');
    await db.query('UPDATE web_rooms SET pending_request=$2,control_version=control_version+1,updated_at=now() WHERE id=$1',[id,request]);
  }
  return readSeatPosition(db,id,player);
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
  if (!details.trim()) reject(400, 'Describe what you expected to happen.');
  const display = reportDisplay(client);
  const { rows: [position] } = await db.query('SELECT mode,' + seat + ' AS state FROM web_positions WHERE room_id=$1 AND revision=$2', [id, revision]);
  if (!position) reject(409, 'The reported position is unavailable.');
  // The authoritative board and log come from the exact historical revision, even
  // if the other player advanced while the reporter was writing their note.
  const { choices, history, ...board } = position.state;
  const manual = position.mode === 'manual';
  const snapshot = { schemaVersion: 1, mode:position.mode, engineVersion:manual ? 'Manual table' : 'Forge Desktop 2.0.13',
    matchId:id,revision,viewer:seat,board:manual ? position.state.view : board,
    actions:manual ? (position.state.view?.handoffDecision?.choices ?? []).map(label => ({label})) : choices,
    history,...display };
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
