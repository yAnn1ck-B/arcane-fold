import { randomBytes, randomUUID } from 'node:crypto';
import { pool, transaction } from './db.mjs';
import { createGame } from './forge.mjs';
import { encodePriority, decodePriority } from './priority.mjs';
import { historySteps, retirePositions, rewindForge } from './room-history.mjs';
import { displayPosition, seatText } from './room-display.mjs';
import { createManual, manualView, applyManual } from './manual.mjs';
import { getPlayableDeck, playDeckOptions } from './league-decks.mjs';

export function reject(status, message) {
  throw Object.assign(new Error(message), { status });
}
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const engines = new Map();
const seatFor = (room, player) => room.host === player ? 'player' : 'opponent';
const seatNames = room => ({player:room.host_name ?? 'Host', opponent:room.guest_name ?? 'Guest'});
// With exactly one other account, the host can see who can fill the open seat.
const waitingForName = `CASE WHEN r.status='waiting' AND r.guest IS NULL AND h.email IS NOT NULL
  THEN (SELECT CASE WHEN count(*)=1 THEN min(name) END FROM web_accounts WHERE email<>h.email)
  END AS waiting_for_name`;
function summary(room, player) {
  return { id: room.id, status: room.status, label: room.label, revision: room.revision,
    seat: seatFor(room, player), seatNames:seatNames(room), waitingForName:room.waiting_for_name ?? null };
}
export async function lobby(player, db = pool) {
  const { rows } = await db.query(`SELECT r.id,r.status,r.label,r.revision,r.host,r.guest,r.updated_at,r.paused_at,
    c.id IS NOT NULL AS current,h.name AS host_name,g.name AS guest_name,${waitingForName}
    FROM web_rooms r LEFT JOIN web_accounts h ON h.player_id=r.host LEFT JOIN web_accounts g ON g.player_id=r.guest
    LEFT JOIN web_current_game c ON c.id=r.id
    WHERE r.archived_at IS NULL AND r.superseded_by IS NULL
      AND ((r.status<>'waiting' AND (r.host=$1 OR r.guest=$1)) OR c.id=r.id)
    ORDER BY r.updated_at DESC,r.id`, [player]);
  const rooms = [], openRooms = [];
  for (const room of rows) {
    if (room.host === player || room.guest === player) rooms.push({
      ...summary(room, player), current:room.current, paused:!!room.paused_at, updatedAt:room.updated_at,
    });
    else if (room.status === 'waiting') openRooms.push({ id: room.id, hostName: room.host_name ?? 'Host', openedAt: room.updated_at });
  }
  return { rooms, openRooms, decks: await playDeckOptions(db, player) };
}
async function lockLobby(db) {
  // Serialize create, join and resume even when the shared lobby is empty.
  await db.query('SELECT pg_advisory_xact_lock(hashtext(current_schema()), 347120)');
  const {rows:[current]} = await db.query('SELECT * FROM web_current_game');
  return current;
}
export function createRoom(player, deckId, database = pool) {
  return transaction(async db => {
    const current = await lockLobby(db);
    if (current) {
      if (current.host === player || current.guest === player) return {id:current.id};
      reject(409, 'A game is already open. Choose Join game in the lobby.');
    }
    const deck = await getPlayableDeck(db, player, deckId);
    if (!deck) reject(400, 'Choose a playable deck.');
    const id = randomUUID();
    await db.query(`INSERT INTO web_rooms(id,host,host_deck,invite_code,seed,label)
      VALUES($1::uuid,$2,$3,($1::uuid)::text,$4,$5)`,
      [id, player, deck.text, randomBytes(8).readBigInt64BE().toString(), deck.name]);
    return {id};
  }, database);
}
export function resumeRoom(player, id, database = pool) {
  if (!uuid.test(id)) reject(404,'Game unavailable.');
  return transaction(async db => {
    const current = await lockLobby(db);
    const {rows:[room]} = await db.query(
      'SELECT status,paused_at FROM web_rooms WHERE id=$1 AND archived_at IS NULL AND (host=$2 OR guest=$2) FOR UPDATE', [id,player]);
    if (!room) reject(404,'Game unavailable.');
    if (room.status !== 'playing') reject(409,'This game is no longer in progress.');
    if (!room.paused_at) return {id};
    if (current) reject(409,'Finish the current game before resuming an earlier game.');
    await db.query('UPDATE web_rooms SET paused_at=NULL WHERE id=$1',[id]);
    return {id};
  }, database);
}
async function roomRow(db, id, player, lock = false) {
  if (!uuid.test(id)) reject(404, 'Game unavailable.');
  const columns = lock ? '*' : `id,status,label,revision,host,guest,mode,pending_request,control_version,last_resolution,paused_at,
    (SELECT name FROM web_accounts WHERE player_id=web_rooms.host) AS host_name,
    (SELECT name FROM web_accounts WHERE player_id=web_rooms.guest) AS guest_name`;
  const { rows: [row] } = await db.query('SELECT ' + columns + ' FROM web_rooms WHERE id=$1 AND archived_at IS NULL AND (host=$2 OR guest=$2)' + (lock ? ' FOR UPDATE' : ''), [id, player]);
  if (!row) reject(404, 'Game unavailable.');
  if (row.paused_at) reject(409,'This earlier game is saved. Resume it from the lobby.');
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
  const outcome = room.status === 'finished' ? engine.outcome() : null;
  await db.query('INSERT INTO web_positions(room_id,revision,player,opponent,replay_cursor,outcome) VALUES($1,$2,$3,$4,$5,$6)',
    [room.id, room.revision, p, o, cursor, outcome]);
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
async function mutate(work, database = pool) {
  let active;
  try {
    return await transaction(db => work(db, (room, engine) => {
      active = { id: room.id, engine, revision: room.revision + 1, touched: Date.now(), busy: true };
      engines.set(room.id, active);
    }), database);
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
export async function joinRoom(player, roomId, deckId, database = pool) {
  if (typeof roomId !== 'string' || !uuid.test(roomId)) reject(404, 'Game unavailable.');
  return mutate(async (db, track) => {
    const current = await lockLobby(db);
    const { rows: [room] } = await db.query('SELECT * FROM web_rooms WHERE id=$1 AND archived_at IS NULL FOR UPDATE', [roomId]);
    if (!room) reject(404, 'Game unavailable.');
    if (room.superseded_by) reject(409, 'This game is closed. Return to the lobby to choose an open game.');
    if (room.paused_at) reject(409, 'This earlier game is saved. Resume it from the lobby.');
    if (room.host === player) reject(409, 'You already host this game.');
    if (room.guest === player) return { id: room.id };
    if (room.guest || room.status !== 'waiting') reject(409, 'This game is no longer open.');
    if (current?.id !== room.id) reject(409, 'Another game is current. Return to the lobby.');
    const deck = await getPlayableDeck(db, player, deckId);
    if (!deck) reject(400, 'Choose a playable deck.');
    const engine = await startForgeGame(db, room, player, deck.text);
    track(room, engine);
    await db.query("UPDATE web_rooms SET guest=$2,guest_deck=$3,label=label || ' vs. ' || $4 WHERE id=$1", [room.id, player, deck.text, deck.name]);
    await savePosition(db, room, engine);
    // A previously anonymous browser can claim its old waiting game after a
    // migration. Close any such unused reservation as this pair begins play.
    await db.query(`UPDATE web_rooms SET superseded_by=$1 WHERE id<>$1 AND host IN ($2,$3)
      AND archived_at IS NULL AND status='waiting' AND guest IS NULL AND superseded_by IS NULL`, [room.id,room.host,player]);
    return { id: room.id };
  }, database);
}
export async function startForgeGame(db, room, guest, guestDeck) {
  const {rows} = await db.query('SELECT id,priority_settings FROM web_players WHERE id IN ($1,$2)', [room.host,guest]);
  const priorities = Object.fromEntries(rows.map(row => [seatFor(room,row.id),row.priority_settings]));
  // The private room seed is uniformly random. Its low bit makes the choice stable across a retried join.
  const startingSeat = (BigInt(room.seed) & 1n) === 0n ? 'player' : 'opponent';
  return createGame({decks:[room.host_deck,guestDeck],seed:room.seed,startingSeat,priorities});
}
export async function roomView(id, player) {
  return readSeatPosition(pool, id, player);
}

// Before structured results, the final public position held Forge's English
// outcome sentences for both players. Leave unrecognized results unspecified.
function legacyOutcome(state) {
  if (state?.stage !== 'finished' || typeof state.prompt !== 'string') return null;
  const won = /\bPlayer ([12]) has won (?:because all opponents have lost|due to effect of )/.exec(state.prompt);
  if (won) return { winner: won[1] === '1' ? 'player' : 'opponent', reason: 'rules' };
  if (state.prompt.includes('has accepted that the game is a draw') ||
      ['Player 1 has lost ', 'Player 2 has lost '].every(text => state.prompt.includes(text))) {
    return { winner: null, reason: 'rules' };
  }
  return null;
}

export async function readSeatPosition(db, id, player) {
  if (!uuid.test(id)) reject(404,'Game unavailable.');
  // Read consent, lineage and the seat projection in the same MVCC snapshot. A
  // rewind can retire the old timeline while a browser is polling.
  const { rows:[room] } = await db.query(`SELECT r.id,r.status,r.label,r.revision,r.host,r.guest,
    r.mode,r.pending_request,r.control_version,r.last_resolution,r.superseded_by,r.paused_at,p.outcome,
    h.name AS host_name,g.name AS guest_name,${waitingForName},
    CASE WHEN r.host=$2 THEN p.player ELSE p.opponent END AS state,
    EXISTS(SELECT 1 FROM web_positions prior WHERE prior.room_id=r.id AND prior.mode=r.mode
      AND prior.retired_at IS NULL AND prior.revision<r.revision) AS undoable
    FROM web_rooms r LEFT JOIN web_positions p ON p.room_id=r.id AND p.revision=r.revision
    LEFT JOIN web_accounts h ON h.player_id=r.host LEFT JOIN web_accounts g ON g.player_id=r.guest
    WHERE r.id=$1 AND r.archived_at IS NULL AND (r.host=$2 OR r.guest=$2)`,[id,player]);
  if (!room) reject(404,'Game unavailable.');
  if (room.superseded_by) reject(410, 'This game is closed. Return to the lobby to open your current game.');
  if (room.paused_at) reject(409,'This earlier game is saved. Resume it from the lobby.');
  const info = summary(room, player);
  const state = displayPosition(room.state, info.seatNames, info.seat);
  const proposalLabel = request => request?.targetLabel ? {...request, targetLabel:seatText(request.targetLabel,info.seatNames)} : request;
  return { ...info, mode:room.mode, pendingRequest:room.status === 'playing' ? proposalLabel(room.pending_request) : null, controlVersion:room.control_version,
    outcome:room.outcome ?? legacyOutcome(room.state),
    lastResolution:proposalLabel(room.last_resolution), undoAvailable:room.status === 'playing' && room.undoable,
    state:room.mode === 'forge' ? state : null, manualState:room.mode === 'manual' ? state : null };
}

export function roomHistory(id, player, database = pool) {
  return transaction(async db => {
    await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const room = await roomRow(db,id,player);
    const steps = await historySteps(db,room,seatFor(room,player));
    const names = seatNames(room);
    return {revision:room.revision, steps:steps.map(step => ({...step, label:seatText(step.label,names)}))};
  }, database);
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

async function concede(db, room, player, body) {
  if (body.concede !== true || Object.keys(body).some(key => !['concede','revision','controlVersion'].includes(key))) {
    reject(400, 'Choose only the concession action.');
  }
  const seat = seatFor(room, player);
  const winner = seat === 'player' ? 'opponent' : 'player';
  if (room.status === 'finished' && body.revision === room.revision - 1) {
    const current = await readSeatPosition(db, room.id, player);
    if (current.outcome?.reason === 'concession' && current.outcome.winner === winner) return current;
  }
  if (room.status !== 'playing' || !room.guest || room.revision !== body.revision ||
      room.control_version !== (body.controlVersion ?? 0)) reject(409, 'The game changed. Review the current position.');

  const { rows:[previous] } = await db.query('SELECT player,opponent,replay_cursor FROM web_positions WHERE room_id=$1 AND revision=$2',
    [room.id, room.revision]);
  const revision = room.revision + 1;
  const entry = {turn: previous.player.turn, text: seat === 'player' ? 'Player 1 conceded. Player 2 wins.' : 'Player 2 conceded. Player 1 wins.'};
  const manual = room.mode === 'manual';
  for (const projection of [previous.player, previous.opponent]) {
    projection.stage = 'finished';
    projection.history.push(entry);
    if (manual) {
      projection.actor = null;
      projection.looking = false;
      projection.requiredOpening = false;
      delete projection.view.handoffDecision;
    } else {
      projection.revision = revision;
      projection.prompt = entry.text;
      projection.choices = [];
      delete projection.damageAssignment;
      delete projection.librarySearch;
      delete projection.revealedToYou;
    }
  }
  if (manual) room.checkpoint.history.push(entry);
  // A concession can happen between any two engine decisions. Keep the last
  // verified Forge cursor or manual board alongside the new terminal position.
  await db.query(`INSERT INTO web_positions(room_id,revision,player,opponent,mode,replay_cursor,manual_checkpoint,outcome)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [room.id, revision, previous.player, previous.opponent, room.mode,
    previous.replay_cursor, manual ? room.checkpoint : null, { winner, reason:'concession' }]);
  await db.query(`UPDATE web_rooms SET status='finished',revision=$2,checkpoint=$3,pending_request=NULL,
    last_resolution=NULL,control_version=control_version+1,updated_at=now() WHERE id=$1`, [room.id, revision, room.checkpoint]);
  await forgetEngine(room.id);
  return readSeatPosition(db, room.id, player);
}

export async function applyMove(db, id, player, body, track) {
  const room = await roomRow(db, id, player, true);
  if (Object.hasOwn(body,'concede')) return concede(db, room, player, body);
  if (room.status !== 'playing' || room.revision !== body.revision) reject(409, 'The game changed. Refresh to see the current decision.');
  if (room.pending_request) reject(409, 'Respond to the pending game request before continuing.');
  if (room.control_version !== (body.controlVersion ?? 0)) reject(409,'A game request changed. Review the position and choose your action again.');
  const seat = seatFor(room, player);
  if (room.mode === 'manual') {
    if (!body.manualAction || Object.hasOwn(body,'actionId') || Object.hasOwn(body,'stop')) reject(400,'Choose a manual action.');
    await saveManualPosition(db,room,await applyManual(room.checkpoint,seat,body.manualAction));
    return readSeatPosition(db,id,player);
  }
  const stop = Object.hasOwn(body, 'stop');
  if (stop === Object.hasOwn(body, 'actionId') || (!stop && typeof body.actionId !== 'string')) reject(400, 'Choose one available action.');
  let settings;
  if (stop) {
    try { settings = decodePriority(typeof body.stop === 'string' ? body.stop : encodePriority(body.stop)); }
    catch { reject(400, 'Invalid priority stop.'); }
  }
  const engine = await currentEngine(room);
  track(room, engine);
  try {
    if (stop) {
      await engine.stop(seat, settings);
      await db.query('UPDATE web_players SET priority_settings=$2 WHERE id=$1', [player,settings]);
    } else await engine.act(seat, body.actionId);
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
  if (room.status !== 'playing') reject(409, 'Requests are only available during a game.');
  if (!room.guest || room.revision !== body.revision || room.control_version !== (body.controlVersion ?? 0)) {
    reject(409, 'The game changed. Review the current position.');
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
    if (pending) reject(409,'There is already a request in this game.');
    const request = {id:randomUUID(),kind:body.kind,requester:seat};
    if (body.kind === 'manual') {
      if (room.mode !== 'forge' || room.status !== 'playing') reject(409,'Manual play can start during a Forge game.');
    } else if (body.kind === 'undo') {
      const step = (await historySteps(db,room)).find(step => step.revision === body.targetRevision);
      if (!step) reject(409,'Choose an earlier position from the current game history.');
      request.targetRevision = step.revision;
      request.targetLabel = step.label;
    } else reject(400,'Unknown game request.');
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
  const room = await roomRow(db, id, player, true);
  const seat = seatFor(room, player);
  const { revision, details = '', report: client } = body;
  if (!Number.isInteger(revision) || !uuid.test(client?.id ?? '') || typeof details !== 'string' || details.length > 1000) reject(400, 'Invalid issue report.');
  if (!details.trim()) reject(400, 'Describe what you expected to happen.');
  const display = reportDisplay(client);
  const { rows: [position] } = await db.query('SELECT mode,outcome,' + seat + ' AS state FROM web_positions WHERE room_id=$1 AND revision=$2', [id, revision]);
  if (!position) reject(409, 'The reported position is unavailable.');
  // The authoritative board and log come from the exact historical revision, even
  // if the other player advanced while the reporter was writing their note.
  const { choices, history, ...board } = position.state;
  const manual = position.mode === 'manual';
  const snapshot = { schemaVersion: 1, mode:position.mode, engineVersion:manual ? 'Manual play' : 'Forge Desktop 2.0.13',
    matchId:id,revision,viewer:seat,...(position.outcome && {outcome:position.outcome}),board:manual ? position.state.view : board,
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
