import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { migrate, pool } from './db.mjs';

const database = 'arcane_fold_web';
const dir = path.resolve('.web-data');
const data = path.join(dir, 'postgres');
const port = 55432;
function ownerAccess(file, directory = false) {
  if (process.platform !== 'win32') return;
  const account = process.env.USERDOMAIN + '\\' + process.env.USERNAME;
  const mode = directory ? '(OI)(CI)F' : 'F';
  const acl = spawnSync('icacls.exe', [file, '/inheritance:r', '/grant:r',
    account + ':' + mode, '*S-1-5-18:' + mode, '*S-1-5-32-544:' + mode],
    { windowsHide: true, stdio: 'pipe' });
  if (acl.status !== 0) throw new Error('Could not restrict access to the local database files.');
}
function pgTool(tool, args) {
  const bin = process.env.PG_BINDIR || (process.platform === 'win32' ? 'C:/Program Files/PostgreSQL/18/bin' : '');
  const result = spawnSync(path.join(bin, tool + (process.platform === 'win32' ? '.exe' : '')), args,
    { windowsHide: true, stdio: 'inherit' });
  if (result.error || result.status !== 0) throw new Error(tool + ' did not complete.');
}
async function secret(name) {
  const file = path.join(dir, name);
  try { await writeFile(file, randomBytes(36).toString('hex') + '\n', { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  return (await readFile(file, 'utf8')).trim();
}
async function provision() {
  // Existing installations can use PGHOST/PGPORT/PGUSER and a libpq password file.
  // DATABASE_URL is an already provisioned application connection.
  const local = process.argv.includes('--local');
  if (local && process.env.DATABASE_URL && !existsSync(path.join(dir, 'admin-password'))) {
    throw new Error('An application connection is configured. Run web:db without --local to use it.');
  }
  if (!local && process.env.DATABASE_URL) return;
  let connection = { database: 'postgres' };
  let password;
  if (local) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    ownerAccess(dir, true);
    // Keep generated files ignored even when switching to a pre-web branch.
    await writeFile(path.join(dir, '.gitignore'), '*\n', { mode: 0o600 });
    const adminPassword = await secret('admin-password');
    password = await secret('app-password');
    if (!existsSync(path.join(data, 'PG_VERSION'))) {
      pgTool('initdb', ['-D', data, '-U', 'league_admin', '--auth=scram-sha-256', '--encoding=UTF8',
        '--locale=C', '--pwfile=' + path.join(dir, 'admin-password')]);
    }
    const pidFile = path.join(data, 'postmaster.pid');
    let running = false;
    if (existsSync(pidFile)) {
      try { process.kill(Number((await readFile(pidFile,'utf8')).split(/\r?\n/)[0]), 0); running = true; } catch { /* restart a stopped cluster */ }
    }
    if (!running) pgTool('pg_ctl', ['start', '-D', data, '-l', path.join(dir, 'postgres.log'), '-w', '-o', '-h 127.0.0.1 -p ' + port]);
    connection = { ...connection, host: '127.0.0.1', port, user: 'league_admin', password: adminPassword };
  }
  const admin = new pg.Client(connection);
  await admin.connect();
  try {
    if (local && !(await admin.query("SELECT 1 FROM pg_roles WHERE rolname='league_app'")).rowCount) {
      // This password contains only locally generated hex digits.
      if (!/^[0-9a-f]{72}$/.test(password)) throw new Error('Invalid local application password file.');
      await admin.query("CREATE ROLE league_app LOGIN PASSWORD '" + password + "'");
    }
    if (!(await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [database])).rowCount) {
      await admin.query('CREATE DATABASE arcane_fold_web' + (local ? ' OWNER league_app' : ''));
    }
  } finally { await admin.end(); }
  if (local) {
    const url = 'postgresql://league_app:' + password + '@127.0.0.1:' + port + '/' + database;
    if (!existsSync('.env.web')) await writeFile('.env.web', 'DATABASE_URL=' + url + '\n', { flag: 'wx', mode: 0o600 });
    else if (process.env.DATABASE_URL !== url) throw new Error('Existing .env.web points to a different database.');
    ownerAccess('.env.web');
    // The pool is configured at module load, so provision using the new connection.
    process.env.DATABASE_URL = url;
    const localDb = await import('./db.mjs?provisioned');
    try { await localDb.migrate(); } finally { await localDb.pool.end(); }
  }
}
try {
  await provision();
  if (!process.argv.includes('--local')) await migrate();
  console.log('Arcane Fold web database is ready.');
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally { await pool.end(); }
