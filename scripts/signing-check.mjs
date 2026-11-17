import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { decodePublicKey, decodeSignature } from './verify-release.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function verifierEnvironment(source) {
  // The public verifier needs no credentials, including GitHub runner tokens.
  const allowed = new Set(['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'PATHEXT', 'COMSPEC', 'LANG', 'LC_ALL']);
  return Object.fromEntries(Object.entries(source).filter(([name]) => allowed.has(name.toUpperCase())));
}

export function capturedCommand(command, args, env, spawn = spawnSync) {
  // Never forward a signer's output or exception: it may contain secret material.
  try {
    const result = spawn(command, args, { cwd: projectRoot, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 120_000, maxBuffer: 1024 * 1024 });
    return !result.error && result.status === 0;
  } catch {
    return false;
  }
}

function context() {
  const config = JSON.parse(readFileSync(path.join(projectRoot, 'src-tauri/tauri.conf.json'), 'utf8'));
  const version = config.version;
  if (!/^\d+\.\d+\.\d+$/.test(version) || config.plugins?.updater?.requireSignedVersion !== true) throw new Error('Invalid signing-check configuration.');
  const publicKey = decodePublicKey(config.plugins.updater.pubkey);
  const publicKeySha256 = createHash('sha256').update(Buffer.from(publicKey, 'base64')).digest('hex');
  if (!process.env.RUNNER_TEMP || !path.isAbsolute(process.env.RUNNER_TEMP)) throw new Error('An isolated runner temporary directory is required.');
  const temporary = realpathSync(process.env.RUNNER_TEMP);
  const directory = path.join(temporary, 'eternal-league-signing-check');
  const fixture = path.join(directory, 'public-signing-fixture.txt');
  return { version, publicKey, publicKeySha256, directory, fixture };
}

function validateFixture({ directory, fixture }) {
  if (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory() || lstatSync(fixture).isSymbolicLink() || !lstatSync(fixture).isFile() || lstatSync(fixture).size > 4096) throw new Error('Invalid temporary signing fixture.');
}

function execute(mode) {
  const state = context();
  const { version, publicKey, publicKeySha256, directory, fixture } = state;
  const evidence = { version, publicKeySha256 };
  if (mode === 'prepare') {
    mkdirSync(directory);
    writeFileSync(fixture, `Harmless Eternal League encrypted-signing smoke fixture for ${version}.\nThis is public test text, not an application or user data.\n`, { flag: 'wx' });
    console.log(JSON.stringify({ prepared: true, ...evidence }));
    return;
  }
  validateFixture(state);
  if (mode === 'sign') {
    if (!process.env.TAURI_SIGNING_PRIVATE_KEY?.trim() || !process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD?.trim() || existsSync(`${fixture}.sig`)) throw new Error('Signing smoke prerequisites are missing.');
    const env = { ...verifierEnvironment(process.env), TAURI_SIGNING_PRIVATE_KEY: process.env.TAURI_SIGNING_PRIVATE_KEY, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD };
    const cli = path.join(projectRoot, 'node_modules/@tauri-apps/cli/tauri.js');
    if (!capturedCommand(process.execPath, [cli, 'signer', 'sign', '--app-version', version, fixture], env)) throw new Error('Encrypted signing smoke failed.');
    console.log(JSON.stringify({ signed: true, ...evidence }));
    return;
  }
  if (mode !== 'verify' || !process.env.MINISIGN_EXECUTABLE) throw new Error('Invalid public verification request.');
  const signature = `${fixture}.sig`;
  if (lstatSync(signature).isSymbolicLink() || !lstatSync(signature).isFile() || lstatSync(signature).size > 16000) throw new Error('Invalid public signature.');
  const decoded = `${fixture}.minisig`;
  writeFileSync(decoded, decodeSignature(readFileSync(signature, 'utf8'), version), { flag: 'wx' });
  if (!capturedCommand(process.env.MINISIGN_EXECUTABLE, ['-Vm', fixture, '-x', decoded, '-P', publicKey], verifierEnvironment(process.env))) throw new Error('Public signing smoke verification failed.');
  const report = { verified: true, ...evidence };
  writeFileSync(path.join(directory, 'evidence.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Encrypted signing check verified: true\n\nVersion: ${version}\n\nPublic key SHA256: ${publicKeySha256}\n`);
  console.log(JSON.stringify(report));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) throw new Error('Invalid signing smoke request.');
    execute(process.argv[2]);
  } catch {
    // Withhold paths, child output, and raw exceptions throughout the secret step.
    console.error('Encrypted signing smoke check failed.');
    process.exitCode = 1;
  }
}
