import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
const accounts = [
  { name: 'Yannick', email: 'yannick@arcane-fold.test' },
  { name: 'Jef', email: 'jef@arcane-fold.test' },
];
export const credentialsFile = process.env.WEB_PLAYER_LOGINS_FILE ||
  fileURLToPath(new URL('../.web-data/player-logins.json', import.meta.url));

async function loadPasswords(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const passwords = accounts.map(({ email }) => ({ email, password: randomBytes(15).toString('base64url') }));
  // Publish the complete file before committing its hashes. A retried migration
  // then uses the same passwords, even if the first process stopped mid-setup.
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temporary, JSON.stringify(passwords, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    try {
      await link(temporary, file);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      return JSON.parse(await readFile(file, 'utf8'));
    }
    return passwords;
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

// Called under the migration transaction's advisory lock.
export async function seedAccounts(db, file = credentialsFile) {
  const { rows } = await db.query('SELECT email FROM web_accounts');
  const missing = accounts.filter(account => !rows.some(row => row.email === account.email));
  if (!missing.length) return;
  const passwords = await loadPasswords(file);
  for (const { name, email } of missing) {
    const password = Array.isArray(passwords) && passwords.find(item => item?.email === email)?.password;
    if (typeof password !== 'string' || !password.length || password.length > 256) {
      throw new Error('Missing or invalid player password for ' + email + ' in ' + file);
    }
    const salt = randomBytes(16).toString('hex');
    const hash = (await derive(password, salt, 32)).toString('hex');
    await db.query('INSERT INTO web_accounts(email,name,password_hash) VALUES($1,$2,$3)', [email, name, salt + ':' + hash]);
  }
}

const digest = token => /^[a-f0-9]{64}$/.test(token ?? '') ? createHash('sha256').update(token).digest('hex') : null;
export function readCookie(req, name) {
  return req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith(name + '='))?.slice(name.length + 1);
}

export async function activeAccount(db, token) {
  const hash = digest(token);
  if (!hash) return null;
  const { rows } = await db.query(`SELECT a.name,a.email,a.player_id
    FROM web_login_sessions s JOIN web_accounts a USING(email)
    WHERE s.token_hash=$1 AND s.expires_at > now()`, [hash]);
  return rows[0] ?? null;
}

const isLoopback = value => ['localhost', '127.0.0.1', '::1', '[::1]', '::ffff:127.0.0.1'].includes(value);
export function allowsLocalPlay(req, url, bind) {
  return process.env.WEB_LOCAL_PLAY !== '0' && isLoopback(bind) && isLoopback(url.hostname) &&
    isLoopback(req.socket.remoteAddress) &&
    !Object.keys(req.headers).some(key => key === 'forwarded' || key.startsWith('x-forwarded-'));
}

export async function signOut(db, token) {
  const hash = digest(token);
  if (hash) await db.query('DELETE FROM web_login_sessions WHERE token_hash=$1', [hash]);
}

export async function signIn(db, body, { local = false, previousToken, legacyToken } = {}) {
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const { rows: [account] } = await db.query('SELECT * FROM web_accounts WHERE email=$1 FOR UPDATE', [email]);
  let valid = false;
  if (account && accounts.some(builtIn => builtIn.email === email)) {
    if (local) valid = true;
    else if (typeof body.password === 'string' && body.password.length > 0 && body.password.length <= 256) {
      const [salt, hash] = account.password_hash.split(':');
      valid = timingSafeEqual(await derive(body.password, salt, 32), Buffer.from(hash, 'hex'));
    }
  }
  if (!valid) throw Object.assign(new Error('Incorrect email or password.'), { status: 401 });
  let playerId = account.player_id;
  if (!playerId) {
    const legacyHash = digest(legacyToken);
    if (legacyHash) {
      const { rows: [legacy] } = await db.query('SELECT id FROM web_players WHERE session_hash=$1 FOR UPDATE', [legacyHash]);
      if (legacy && !(await db.query('SELECT 1 FROM web_accounts WHERE player_id=$1', [legacy.id])).rowCount) {
        playerId = legacy.id;
      }
    }
    if (!playerId) {
      playerId = randomUUID();
      // A new account has no pre-login browser cookie.
      await db.query('INSERT INTO web_players(id,session_hash) VALUES($1,$2)', [playerId, 'account:' + playerId]);
    }
    await db.query('UPDATE web_accounts SET player_id=$2 WHERE email=$1', [email, playerId]);
  }
  await signOut(db, previousToken);
  const token = randomBytes(32).toString('hex');
  await db.query(`INSERT INTO web_login_sessions(token_hash,email,expires_at)
    VALUES($1,$2,now() + interval '365 days')`, [digest(token), email]);
  return { user: { email, name: account.name }, token, playerId };
}
