import http from 'node:http';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate, pool, transaction } from './db.mjs';
import { cancelRoom, closeGames, createRoom, joinRoom, lobby, move, reject, report, resumeRoom, roomHistory, roomView, tableRequest } from './rooms.mjs';
import { leagueCommand } from './league.mjs';
import { deckCatalogCommand } from './league-decks.mjs';
import { serveArt } from './art.mjs';
import { activeAccount, allowsLocalPlay, readCookie, signIn, signOut } from './accounts.mjs';

const root = fileURLToPath(new URL('../dist-web/', import.meta.url));
const bind = process.env.WEB_HOST || '127.0.0.1';
const port = Number(process.env.WEB_PORT || 4317);
const allowed = new Set(process.env.WEB_ORIGIN ? [new URL(process.env.WEB_ORIGIN).origin] :
  ['http://127.0.0.1:' + port, 'http://localhost:' + port, 'http://[::1]:' + port]);
const localForge = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Forge 2.0.13');
if (!process.env.FORGE_INSTALL && existsSync(path.join(localForge, 'forge-gui-desktop-2.0.13-jar-with-dependencies.jar'))) {
  process.env.FORGE_INSTALL = localForge;
}
const loginCookie = 'el_web_login';
function writeLoginCookie(res, token) {
  const secure = process.env.WEB_ORIGIN?.startsWith('https://') ? '; Secure' : '';
  res.setHeader('Set-Cookie', loginCookie + '=' + token + '; HttpOnly; SameSite=Lax; Path=/; Max-Age=' + (token ? 31536000 : 0) + secure);
}
async function payload(req) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') reject(415, 'Send JSON.');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 4 * 1024 * 1024) reject(413, 'Request too large.');
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (body && typeof body === 'object' && !Array.isArray(body)) return body;
  } catch { /* use the same error for malformed requests */ }
  reject(400, 'Invalid JSON request.');
}
async function api(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/art') return serveArt(url, res);
  const previousToken = readCookie(req, loginCookie);
  const localPlay = allowsLocalPlay(req, url, bind);
  if (req.method === 'POST' && (url.pathname === '/api/login' || url.pathname === '/api/local-login')) {
    const local = url.pathname === '/api/local-login';
    if (local && !localPlay) reject(403, 'Local play is available only on the host computer.');
    const body = await payload(req);
    const { user, token } = await transaction(db => signIn(db, body, {
      local, previousToken, legacyToken: readCookie(req, 'el_web_session'),
    }));
    writeLoginCookie(res, token);
    return { user, localPlay };
  }
  const account = await activeAccount(pool, previousToken);
  if (req.method === 'GET' && url.pathname === '/api/auth') {
    return { user: account && { name: account.name, email: account.email }, localPlay };
  }
  const expectedAccount = req.headers['x-arcane-account'];
  if (account && expectedAccount !== undefined && expectedAccount !== account.email) {
    reject(401, 'Sign in to continue.');
  }
  if (req.method === 'POST' && url.pathname === '/api/logout') {
    await payload(req);
    if (account) {
      await signOut(pool, previousToken);
      writeLoginCookie(res, '');
    }
    return { user: null, localPlay };
  }
  if (!account) reject(401, 'Sign in to continue.');
  const player = account.player_id;
  if (req.method === 'GET' && url.pathname === '/api/session') return lobby(player);
  const match = /^\/api\/rooms\/([a-z0-9-]+)(?:\/(actions|reports|history|requests|resume|cancel))?$/.exec(url.pathname);
  if (req.method === 'GET' && match && !match[2]) return roomView(match[1], player);
  if (req.method === 'GET' && match?.[2] === 'history') return roomHistory(match[1], player);
  if (req.method !== 'POST') reject(404, 'Endpoint unavailable.');
  const body = await payload(req);
  if (url.pathname === '/api/rooms') return createRoom(player, body.deckId);
  if (url.pathname === '/api/join') return joinRoom(player, body.roomId, body.deckId);
  if (match?.[2] === 'cancel') return cancelRoom(player, match[1]);
  if (match?.[2] === 'resume') return resumeRoom(player, match[1]);
  if (match?.[2] === 'actions') return move(match[1], player, body);
  if (match?.[2] === 'requests') return tableRequest(match[1], player, body);
  if (match?.[2] === 'reports') return report(match[1], player, body);
  const rpc = /^\/api\/league\/([a-z_]+)$/.exec(url.pathname);
  if (rpc) return transaction(async db => {
    await db.query('SELECT id FROM web_players WHERE id=$1 FOR UPDATE', [player]);
    const value = await deckCatalogCommand(db, player, rpc[1], body);
    if (value !== undefined) return value;
    return leagueCommand(db, player, rpc[1], body);
  });
  reject(404, 'Endpoint unavailable.');
}
const types = { '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.webp': 'image/webp', '.woff2': 'font/woff2', '.html': 'text/html; charset=utf-8' };
function json(res, code, value) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}
const server = http.createServer(async (req, res) => {
  try {
    const scheme = process.env.WEB_ORIGIN?.startsWith('https://') ? 'https' : 'http';
    const url = new URL(req.url, scheme + '://' + req.headers.host);
    if (!allowed.has(url.origin) || (req.headers.origin && !allowed.has(req.headers.origin))) reject(403, 'Unexpected request origin.');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    if (url.pathname.startsWith('/api/')) {
      const result = await api(req, res, url);
      if (!res.headersSent) json(res, 200, result);
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') reject(405, 'Method unavailable.');
    const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
    const file = path.resolve(root, relative);
    if (!file.startsWith(path.resolve(root) + path.sep) || relative.includes('\\')) reject(404, 'Page unavailable.');
    const bytes = await readFile(file).catch(() => reject(404, 'Page unavailable.'));
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' https://cards.scryfall.io https://api.scryfall.com data:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
      'Cache-Control': relative.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : bytes);
  } catch (error) {
    // Database, filesystem and subprocess diagnostics belong on the host.
    const internal = Boolean(error.code) || error instanceof TypeError;
    if (internal) console.error('Web request failed.', error.code ?? error.name);
    if (!res.headersSent) json(res, error.status || (internal ? 500 : 400), {
      error: internal ? 'The server could not complete this request.' : error.message,
    });
    else res.end();
  }
});
await migrate();
await new Promise((resolve, rejectListen) => { server.once('error', rejectListen); server.listen(port, bind, resolve); });
console.log('Arcane Fold web is listening at ' + [...allowed][0]);
let ending = false;
async function shutdown() {
  if (ending) return;
  ending = true;
  server.close();
  await closeGames();
  await pool.end();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
