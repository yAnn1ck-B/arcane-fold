import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkMigrations } from './check-migrations.mjs';

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export function compareVersions(a, b) {
  if (!stableVersion.test(a) || !stableVersion.test(b)) throw new Error('Release versions must use stable X.Y.Z SemVer.');
  const left = a.split('.').map(Number), right = b.split('.').map(Number);
  for (let index = 0; index < 3; index++) if (left[index] !== right[index]) return left[index] > right[index] ? 1 : -1;
  return 0;
}
export function nextVersion(current, requested = 'patch') {
  compareVersions(current, current);
  const parts = current.split('.').map(Number);
  if (requested === 'major') { parts[0]++; parts[1] = 0; parts[2] = 0; }
  else if (requested === 'minor') { parts[1]++; parts[2] = 0; }
  else if (requested === 'patch') parts[2]++;
  else {
    if (compareVersions(requested, current) <= 0) throw new Error('Every release must have a new, higher version.');
    return requested;
  }
  return parts.join('.');
}
export function validateVersionValues(values, tag) {
  const version = Object.values(values)[0];
  compareVersions(version, version);
  for (const [file, value] of Object.entries(values)) if (value !== version) throw new Error(`Version mismatch: ${file} has ${value}, expected ${version}.`);
  if (tag !== undefined && tag !== `v${version}`) throw new Error(`Tag must be exactly v${version}.`);
  return version;
}
export function readVersionState(root = projectRoot, tag) {
  checkMigrations(root);
  const json = file => JSON.parse(readFileSync(path.join(root, file), 'utf8'));
  const pkg = json('package.json'), lock = json('package-lock.json'), config = json('src-tauri/tauri.conf.json');
  const cargo = readFileSync(path.join(root, 'src-tauri/Cargo.toml'), 'utf8');
  const cargoLock = readFileSync(path.join(root, 'src-tauri/Cargo.lock'), 'utf8');
  const crateVersion = cargo.match(/\[package\][\s\S]*?\nversion\s*=\s*"([^"]+)"/)?.[1];
  const lockedCrateVersion = cargoLock.match(/\[\[package\]\]\s*\nname = "eternal-league"\s*\nversion = "([^"]+)"/)?.[1];
  const version = validateVersionValues({ 'package.json': pkg.version, 'package-lock.json': lock.version, 'package-lock root': lock.packages?.['']?.version, 'Cargo.toml': crateVersion, 'Cargo.lock': lockedCrateVersion, 'tauri.conf.json': config.version }, tag);
  if (config.identifier !== 'com.eternalleague.desktop') throw new Error('Production must use its clean, permanent desktop identifier.');
  const policy = json('release-policy.json'), development = json('src-tauri/tauri.dev.conf.json');
  if (development.identifier !== 'com.eternalleague.preview' || development.identifier !== policy.developmentIdentifier) throw new Error('Development must use the established played profile.');
  if (config.bundle?.createUpdaterArtifacts !== true) throw new Error('Release updater artifacts must be enabled.');
  const updater = config.plugins?.updater;
  if (!updater?.endpoints?.includes('https://github.com/yAnn1ck-B/eternal-league/releases/latest/download/latest.json')) throw new Error('The release updater endpoint is not configured.');
  const publicKey = Buffer.from(updater.pubkey ?? '', 'base64').toString('utf8');
  if (!publicKey.startsWith('untrusted comment: minisign public key:') || Buffer.from(publicKey.trim().split(/\r?\n/)[1] ?? '', 'base64').length !== 42) throw new Error('A real updater public key is required.');
  const serialized = JSON.stringify(config);
  if (/com\.eternalleague\.preview|\.verification|PREVIEW_WEEKS/i.test(serialized)) throw new Error('Preview configuration cannot be part of the production bundle.');
  const rules = json('src-tauri/league-rules.json');
  if (rules.startedAt !== policy.leagueStartedAt || !Number.isSafeInteger(rules.startedAt) || rules.startedAt <= 0) throw new Error('The established shared league start changed.');
  if (policy.productionIdentifier !== config.identifier) throw new Error('Production identifier changed from the release policy.');
  if (tag && compareVersions(version, policy.initialVersion) < 0) throw new Error('Release predates the initial production version.');
  if (Number(process.env.ETERNAL_LEAGUE_PREVIEW_WEEKS ?? 0) !== 0) throw new Error('Unset the development preview offset before preparing a release.');
  return { version, config, policy };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length && (args[0] !== '--tag' || args.length !== 2)) throw new Error('Usage: check-version.mjs [--tag vX.Y.Z]');
    const { version } = readVersionState(projectRoot, args[1]);
    console.log(`Release versions, production identity, updater key, and shared league anchor match: ${version}`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
