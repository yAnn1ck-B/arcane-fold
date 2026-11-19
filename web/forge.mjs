import { spawn } from "node:child_process";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { decodePriority, encodePriority, validPriorityToken } from "./priority.mjs";

const seats = ["player", "opponent"];
const units = [
  "ForgeImports", "ForgeGame", "ForgeMatch", "ForgeReplay", "ForgeCombat",
  "ForgeLibrary", "ForgeHistory", "ForgeManual", "ForgeNames",
];
const sources = new URL("./forge-bridge/", import.meta.url);
const jarName = "forge-gui-desktop-2.0.13-jar-with-dependencies.jar";

function requireSeat(seat) {
  if (!seats.includes(seat)) throw new Error("Unknown seat.");
}

// Java assigns card IDs while loading deck rows in order. Give the browser
// opaque handles while keeping attachments, choice anchors and board IDs linked.
function seatView(state, seat, revision, pending, seed) {
  requireSeat(seat);
  const activeChoice = state.actor === seat;
  const choosingBlocks = state.choices.some(option => option.kind === "block");
  const handle = id => createHmac("sha256", seed).update(seat + "/" + id).digest("hex").slice(0, 32);
  const visibleIds = new Set();
  const card = item => {
    visibleIds.add(item.id);
    const result = { ...item, id: handle(item.id) };
    if (item.attachedTo) result.attachedTo = handle(item.attachedTo);
    if (item.blockingIds) {
      if (choosingBlocks && !activeChoice) delete result.blockingIds;
      else result.blockingIds = item.blockingIds.map(handle);
    }
    return result;
  };
  const players = {};
  for (const owner of seats) {
    const board = state.players[owner];
    players[owner] = {
      life: board.life, mana: board.mana, manaByColor: board.manaByColor,
      libraryCount: board.libraryCount, handCount: board.handCount,
      hand: owner === seat ? board.hand.map(card) : [],
      battlefield: board.battlefield.map(card), graveyard: board.graveyard.map(card),
      exile: board.exile.map(card),
    };
    const top = board.libraryTopBySeat?.[seat];
    if (top) players[owner].libraryTop = card(top);
  }
  const librarySearch = activeChoice && state.librarySearch
    ? { ...state.librarySearch, cards: state.librarySearch.cards.map(card) }
    : null;
  const stack = state.stack.map(({ targetRefs, ...entry }) => card(entry));
  for (const [index, entry] of state.stack.entries()) {
    if (!entry.targetRefs) continue;
    // A reference can point into a private zone. Only link cards already
    // present in this seat's projection, and use the same opaque IDs.
    const refs = entry.targetRefs.filter(ref => ref.seat || visibleIds.has(ref.cardId))
      .map(ref => ref.cardId ? { cardId: handle(ref.cardId) } : ref);
    if (refs.length) stack[index].targetRefs = refs;
  }
  const view = {
    revision, canUndo: false, sharedSeats: true, battlefieldStatusVersion: 1, stage: state.stage, turn: state.turn,
    active: state.active, actor: state.actor, phase: state.phase, step: state.step,
    prompt: activeChoice || state.stage === "finished" ? state.prompt : "Waiting for your opponent.",
    priorityStop: pending[seat] ?? state.priorityStops[seat],
    history: state.history, stack, players,
    choices: activeChoice ? state.choices.map(option => {
      const projected = { ...option };
      if (option.cardId) projected.cardId = handle(option.cardId);
      if (option.block) projected.block = { ...option.block, attackerId: handle(option.block.attackerId) };
      return projected;
    }) : [],
  };
  if (librarySearch) view.librarySearch = librarySearch;
  if (activeChoice && state.revealedToYou) view.revealedToYou = state.revealedToYou;
  return structuredClone(view);
}

// Version-1 journals and earlier saved seat views omitted phased-out cards
// and these display fields. ForgeReplay already fingerprints phasing and
// summoning sickness in the private engine state.
export function legacyBattlefieldView(state) {
  const { battlefieldStatusVersion, ...legacy } = state;
  legacy.players = Object.fromEntries(seats.map(seat => {
    const board = state.players[seat];
    const battlefield = board.battlefield.filter(card => !card.phasedOut).map(card => {
      const { summoningSick, grantedKeywords, cantAttack, cantBlock, ...original } = card;
      return original;
    });
    return [seat, { ...board, battlefield }];
  }));
  return legacy;
}

// Map.of iteration order differs between processes. Preserve the order of arrays
// (including the offered options) while hashing the entire private engine state.
function digest(state, includeBattlefieldStatus, includeBlockReferences = false) {
  // winner is terminal display metadata derived from Forge. Keep the version-1
  // replay input identical for journals created before it was exposed.
  const { winner, ...replay } = includeBattlefieldStatus ? state : legacyBattlefieldView(state);
  // Reassignments extend the UI choices. Their resulting assignments are
  // already checked by blockingIds, and older journal hashes omit the options.
  replay.choices = replay.choices.filter(choice => !choice.block?.reassign);
  const json = JSON.stringify(replay, (key, value) => {
    // Earlier journals hashed the original display snapshots. New moves also
    // verify the exact combat assignment when attackers share names.
    if (key === "targetRefs" || (!includeBlockReferences && (key === "blockingIds" || key === "block"))) return undefined;
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]]));
  });
  return createHash("sha256").update(json).digest("hex");
}

function legalAction(state, seat, action, pending) {
  if (state.stage !== "decision" || state.actor !== seat ||
      typeof action !== "string" || Buffer.byteLength(action) > 512 || /\p{Cc}/u.test(action)) return false;
  const [id, cardName, ...extra] = action.split("|");
  if (extra.length) return false;
  const stop = pending[seat] ?? state.priorityStops[seat];
  return state.choices.some(option => {
    if (action === option.endTurnId) return option.kind === "pass" && (stop === "auto" ||
      (stop.startsWith("v2:") && !decodePriority(stop).own.length) || state.phase === "Ending phase");
    if (id !== option.id) return false;
    return option.kind === "name" ? !!cardName?.trim() : cardName === undefined;
  });
}

function validateDeck(deck) {
  if (typeof deck !== "string" || Buffer.byteLength(deck) > 256 * 1024) throw new Error("Invalid Forge deck.");
  let main = false;
  let total = 0;
  for (const row of deck.split(/\r?\n/)) {
    const line = row.trim();
    if (line.startsWith("[")) main = line.toLowerCase() === "[main]";
    else if (main && line && !line.startsWith("#")) {
      const match = /^([1-9]\d*)\s+\S/.exec(line);
      if (!match) throw new Error("Invalid main-deck entry.");
      total += Number(match[1]);
    }
  }
  if (total < 7 || total > 2000) throw new Error("Web matches support 7 to 2,000 main-deck cards per seat.");
}

async function launch(install, decks, seed, startingSeat) {
  if (!install) throw new Error("Configure FORGE_INSTALL for Forge Desktop 2.0.13.");
  const directory = resolve(install);
  const jar = join(directory, jarName);
  await access(jar).catch(() => { throw new Error("Forge Desktop 2.0.13 is unavailable on this server."); });
  const source = (await Promise.all(units.map(unit => readFile(new URL(unit + ".java", sources), "utf8")))).join("\n");
  const scratch = await mkdtemp(join(tmpdir(), "arcane-fold-web-game-"));
  const cleanup = () => rm(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  try {
    await Promise.all([
      writeFile(join(scratch, "practice.dck"), decks[0], { mode: 0o600 }),
      writeFile(join(scratch, "opponent.dck"), decks[1], { mode: 0o600 }),
      writeFile(join(scratch, "ForgeGame.java"), source),
    ]);
    const env = {};
    for (const key of ["PATH", "JAVA_HOME", "SystemRoot", "WINDIR", "LANG", "LC_ALL", "LD_LIBRARY_PATH"]) {
      if (process.env[key]) env[key] = process.env[key];
    }
    for (const key of ["HOME", "USERPROFILE", "TMPDIR", "TEMP", "TMP", "APPDATA", "LOCALAPPDATA",
                       "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"]) env[key] = scratch;
    const child = spawn(process.env.JAVA_EXECUTABLE || "java", [
      "-Xmx512m", "-Djava.awt.headless=true", "-Dfile.encoding=UTF-8",
      "-Duser.home=" + scratch, "-Djava.io.tmpdir=" + scratch,
      "-cp", jar, join(scratch, "ForgeGame.java"), directory, scratch, seed, startingSeat,
    ], { cwd: scratch, env, windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });

    let pending;
    let ended = false;
    const done = new Promise(resolveClose => child.once("close", () => {
      ended = true;
      pending?.reject(new Error("Forge stopped before returning a decision."));
      resolveClose();
    }));
    const fail = () => {
      ended = true;
      pending?.reject(new Error("The server could not run this Forge match."));
      if (child.pid && child.exitCode === null) child.kill();
    };
    child.on("error", fail);
    child.stdin.on("error", fail);
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", line => {
      if (line.startsWith("GAME_ERROR ")) return fail();
      if (line.startsWith("GAME_MANUAL ")) {
        const prefix = "GAME_MANUAL " + pending?.nonce + " ";
        if (!pending?.nonce || !line.startsWith(prefix)) return fail();
        try {
          const reply = JSON.parse(line.slice(prefix.length));
          if (reply.match) pending.resolve(reply.match);
          else pending.reject(new Error("Forge could not export this position. Finish the current decision and try again."));
        } catch { fail(); }
        return;
      }
      if (!line.startsWith("GAME_STATE ")) return;
      try {
        const state = JSON.parse(line.slice("GAME_STATE ".length));
        if (!pending || pending.nonce || state.sharedSeats !== true || !seats.includes(state.actor) ||
            (state.stage === "finished" && ![...seats, "draw"].includes(state.winner)) ||
            !["decision", "finished"].includes(state.stage) || typeof state.replayState !== "string") return fail();
        pending.resolve(state);
      } catch { fail(); }
    });
    function next(action, nonce) {
      if (ended || pending) throw new Error("The Forge match is unavailable.");
      return new Promise((resolveState, rejectState) => {
        const timer = setTimeout(fail, action === undefined ? 90_000 : 30_000);
        const settle = callback => value => {
          clearTimeout(timer);
          pending = undefined;
          callback(value);
        };
        pending = { nonce, resolve: settle(resolveState), reject: settle(rejectState) };
        if (action !== undefined) child.stdin.write(action + "\n");
      });
    }
    let cleanupPromise;
    function close() {
      if (!cleanupPromise) {
        fail();
        cleanupPromise = done.then(cleanup);
      }
      return cleanupPromise;
    }
    return { next, close };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

// The caller persists checkpoint() alongside the immutable decks and private seed.
// Supplying that checkpoint verifies each historical decision before accepting moves.
export async function createGame({ decks, seed, checkpoint: saved, startingSeat, priorities = {}, install = process.env.FORGE_INSTALL }) {
  if (!Array.isArray(decks) || decks.length !== 2) throw new Error("Two saved decks are required.");
  decks.forEach(validateDeck);
  if (!/^-?\d{1,20}$/.test(String(seed)) || (typeof seed === "number" && !Number.isSafeInteger(seed)) ||
      BigInt.asIntN(64, BigInt(seed)) !== BigInt(seed)) throw new Error("A signed 64-bit game seed is required.");
  const seedText = String(BigInt(seed));
  // Earlier journals always started with the host. Only new games record a choice.
  const recordedStarter = saved == null ? startingSeat : saved.startingSeat;
  const starter = recordedStarter === undefined ? "player" : recordedStarter;
  requireSeat(starter);
  const engine = await launch(install, decks, seedText, starter);
  let closed = false;
  let state;
  let initial;
  const moves = [];
  let pending = {};
  let queue = Promise.resolve();
  function serialized(fn) {
    const result = queue.then(fn);
    queue = result.catch(() => {});
    return result;
  }
  function view(seat) {
    if (closed) throw new Error("This Forge match is closed.");
    return seatView(state, seat, moves.length, pending, seedText);
  }
  function checkRevision(revision) {
    if (closed) throw new Error("This Forge match is closed.");
    if (revision !== undefined && revision !== moves.length) throw new Error("That game decision has already changed.");
  }
  async function close() {
    closed = true;
    await engine.close();
  }
  async function advance(seat, action, settings = pending, includeBattlefieldStatus = true, includeBlockReferences = true) {
    requireSeat(seat);
    if (!legalAction(state, seat, action, settings)) throw new Error("That choice is unavailable to this seat.");
    const line = Object.keys(settings).length ? "PRIORITY " +
      [settings.player ?? "=", settings.opponent ?? "=", action].join(" ") : action;
    try {
      state = await engine.next(line);
      const after = digest(state, includeBattlefieldStatus, includeBlockReferences);
      moves.push({ seat, action, stops: settings, after, ...(includeBattlefieldStatus && { battlefieldStatusVersion: 1 }),
        ...(includeBlockReferences && { blockReferencesVersion: 1 }) });
      pending = {};
      if (state.stage === "finished") await engine.close();
    } catch (error) {
      await close();
      throw error;
    }
  }
  function validateStops(values) {
    if (!values || typeof values !== "object" || Array.isArray(values) ||
        Object.entries(values).some(([seat, value]) => !seats.includes(seat) || !validPriorityToken(value))) {
      throw new Error("Invalid saved priority settings.");
    }
    return { ...values };
  }
  async function replayStep(step) {
    if (step.battlefieldStatusVersion !== undefined && step.battlefieldStatusVersion !== 1) {
      throw new Error("Unknown saved battlefield format.");
    }
    if (step.blockReferencesVersion !== undefined && step.blockReferencesVersion !== 1) {
      throw new Error("Unknown saved block reference format.");
    }
    pending = validateStops(step.stops);
    // Older moves retain their original hash. Moves made after the upgrade
    // also verify the complete public battlefield, including granted keywords.
    await advance(step.seat, step.action, pending, step.battlefieldStatusVersion === 1, step.blockReferencesVersion === 1);
    if (moves.at(-1).after !== step.after) throw new Error("Forge could not reproduce a saved decision.");
  }
  try {
    state = await engine.next();
    initial = digest(state, false);
    if (saved != null) {
      if (saved.version !== 1 || saved.initial !== initial || !Array.isArray(saved.moves)) {
        throw new Error("Forge could not reproduce the saved opening position.");
      }
      for (const step of saved.moves) await replayStep(step);
      pending = validateStops(saved.pending);
    } else {
      // Settings take effect on the first move after opening hands. Keeping
      // the initial snapshot identical also supports version-1 replay cursors.
      for (const seat of seats) pending[seat] = encodePriority(priorities[seat] ?? {own:[],opponent:[]});
    }
    return {
      view, close, replayStep,
      outcome: () => state.stage === "finished"
        ? { winner: state.winner === "draw" ? null : state.winner, reason: "rules" } : null,
      exportManual: () => serialized(async () => {
        if (closed || state.stage !== "decision") throw new Error("Manual play requires a suspended decision.");
        const nonce = randomUUID();
        const match = await engine.next("EXPORT_MANUAL " + nonce, nonce);
        return { match, history: structuredClone(state.history), actor: state.actor };
      }),
      checkpoint: () => structuredClone({ version: 1, initial, moves, pending,
        ...(recordedStarter !== undefined && { startingSeat: recordedStarter }) }),
      act: (seat, action, revision) => serialized(async () => {
        checkRevision(revision);
        // Replay uses its original protocol throughout. On the first live move
        // at an older position, upgrade each seat's previous setting. Honor an
        // already armed one-shot "next" until the bridge consumes it.
        const settings = { ...pending };
        for (const owner of seats) {
          const previous = pending[owner] ?? state.priorityStops[owner];
          if (!previous.startsWith("v2:") && previous !== "next") {
            settings[owner] = encodePriority(decodePriority(previous));
          }
        }
        await advance(seat, action, settings);
        return view(seat);
      }),
      stop: (seat, stop, revision) => serialized(() => {
        checkRevision(revision);
        requireSeat(seat);
        if (state.stage !== "decision") throw new Error("Invalid priority stop.");
        pending[seat] = encodePriority(typeof stop === "string" ? decodePriority(stop) : stop);
        return view(seat);
      }),
    };
  } catch (error) {
    await close();
    throw error;
  }
}
