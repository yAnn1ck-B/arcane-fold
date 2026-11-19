import { isDeepStrictEqual } from 'node:util';
import { createGame, legacyBattlefieldView } from './forge.mjs';

export async function historySteps(db, room, viewer = null) {
  const { rows } = await db.query(`SELECT revision, COALESCE((player->>'turn')::int,0) AS turn,
      COALESCE(player->>'phase','') AS phase, COALESCE(jsonb_array_length(player->'history'),0) AS "historyCount",
      player->'history'->-1->>'text' AS event, player->>'actor' AS actor,
      (replay_cursor->>'moveCount')::int AS "moveCount",
      CASE $4::text WHEN 'player' THEN player->>'priorityStop' WHEN 'opponent' THEN opponent->>'priorityStop' END AS stop
    FROM web_positions WHERE room_id=$1 AND mode=$2 AND retired_at IS NULL AND revision<$3
    ORDER BY revision`, [room.id, room.mode, room.revision, viewer]);
  return rows.map(({event,actor,moveCount,stop,...position}, index) => {
    const previous = rows[index - 1];
    const phase = position.phase || (position.turn ? 'Decision' : 'Opening hands');
    const actorLabel = actor === 'player' ? 'Player 1' : actor === 'opponent' ? 'Player 2' : '';
    let label = actorLabel ? `${phase} · ${actorLabel} to act` : phase;
    if (event && position.historyCount !== (previous?.historyCount ?? 0)) label = event;
    if (stop && previous && moveCount != null && moveCount === previous.moveCount && stop !== previous.stop) {
      label = `${phase} · Your priority setting changed`;
    }
    if (!index) label = room.mode === 'manual' ? 'Start of manual play' : 'Opening hands dealt';
    return { ...position, label };
  });
}

export async function retirePositions(db, room, fromRevision) {
  if (room.mode === 'forge') {
    await db.query('INSERT INTO web_forge_journals(room_id,head_revision,checkpoint) VALUES($1,$2,$3)',
      [room.id, room.revision, room.checkpoint]);
  }
  await db.query(`UPDATE web_positions SET retired_at=$2
    WHERE room_id=$1 AND revision >= $3 AND mode=$4 AND retired_at IS NULL`,
    [room.id, room.revision, fromRevision, room.mode]);
}

function legacyReferenceList(expected, actual, field) {
  return actual?.map((item, index) => {
    if (expected?.[index]?.[field] !== undefined || item[field] === undefined) return item;
    const legacy = { ...item };
    delete legacy[field];
    return legacy;
  });
}

function compareView(expected, actual, ignoreStops = false) {
  const { revision: originalRevision, ...a } = expected;
  const restored = expected.battlefieldStatusVersion === undefined ? legacyBattlefieldView(actual) : actual;
  const { revision: restoredRevision, ...b } = restored;
  if (b.stack) b.stack = legacyReferenceList(a.stack, b.stack, "targetRefs");
  if (b.choices) {
    if (!a.choices?.some(choice => choice.block?.reassign)) {
      b.choices = b.choices.filter(choice => !choice.block?.reassign);
    }
    b.choices = legacyReferenceList(a.choices, b.choices, "block");
  }
  if (b.players) b.players = Object.fromEntries(seats.map(seat => [seat, {
    ...b.players[seat],
    battlefield: legacyReferenceList(a.players[seat].battlefield, b.players[seat].battlefield, "blockingIds"),
  }]));
  if (ignoreStops) { delete a.priorityStop; delete b.priorityStop; }
  // PostgreSQL JSON and HTTP omit undefined optional fields in engine projections.
  return isDeepStrictEqual(a,JSON.parse(JSON.stringify(b)));
}

const seats = ['player','opponent'];
export function replayPrefix(journal, cursor) {
  if (!journal || cursor.version !== journal.version || cursor.initial !== journal.initial ||
      !Number.isInteger(cursor.moveCount) || cursor.moveCount < 0 || cursor.moveCount > journal.moves.length) {
    throw new Error('The saved position does not belong to this game journal.');
  }
  const moves = journal.moves.slice(0, cursor.moveCount);
  if ((moves.at(-1)?.after ?? null) !== cursor.lastMoveDigest) throw new Error('The saved decision could not be verified.');
  return { ...journal, moves, pending: cursor.pending };
}

// Old snapshots have both complete seat projections but no replay offset. Accept a
// legacy position only if verified replay produces a unique matching decision.
async function locateLegacy(config, journal, position) {
  const probe = await createGame({ ...config, startingSeat: journal.startingSeat });
  let found;
  try {
    if (probe.checkpoint().initial !== journal.initial) throw new Error('The original opening could not be verified.');
    const limit = Math.min(journal.moves.length, position.revision - 1);
    for (let i = 0; i <= limit; i++) {
      if (seats.every(seat => compareView(position[seat], probe.view(seat), true))) {
        if (found) throw new Error('This older position matches multiple decisions. Choose another step.');
        const pending = {};
        for (const seat of seats) {
          const saved = position[seat].priorityStop;
          if (saved !== undefined) pending[seat] = saved;
        }
        found = { ...journal, moves: journal.moves.slice(0,i), pending };
      }
      if (i === limit) break;
      const move = journal.moves[i];
      await probe.replayStep(move);
    }
  } finally { await probe.close(); }
  if (!found) throw new Error('Forge could not reproduce this older position.');
  return found;
}

export async function rewindForge(room, position) {
  const config = { decks: [room.host_deck, room.guest_deck], seed: room.seed };
  const checkpoint = position.replay_cursor ? replayPrefix(room.checkpoint, position.replay_cursor)
    : await locateLegacy(config, room.checkpoint, position);
  const engine = await createGame({ ...config, checkpoint });
  try {
    if (!seats.every(seat => compareView(position[seat],engine.view(seat)))) {
      throw new Error('The restored board differs from the requested position.');
    }
    return engine;
  } catch (error) {
    await engine.close();
    throw error;
  }
}
