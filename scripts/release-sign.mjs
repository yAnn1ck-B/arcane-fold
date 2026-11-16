import { repository } from './github.mjs';
import { canonicalAssetUrl } from './release-assets.mjs';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { readVersionState, projectRoot } from './check-version.mjs';

try {
  const { version } = readVersionState();
  const tag = process.argv[2] ?? `v${version}`;
  if (tag !== `v${version}` || process.argv.length > 4) throw new Error(`Usage: release-sign.mjs [v${version}] [directory]`);
  const directory = path.resolve(process.argv[3] ?? path.join(projectRoot, '.verification', 'releases', tag));
  const files = readdirSync(directory);
  const targets = [['windows-x86_64', '.exe'], ['linux-x86_64', '.AppImage']];
  const payloads = targets.map(([target, extension]) => {
    const matches = files.filter(name => name.endsWith(extension) && name.includes(version));
    if (matches.length !== 1 || /[\\/\0]/.test(matches[0])) throw new Error(`Exactly one ${version} installer is required for ${target}.`);
    return { target, name: matches[0], file: path.join(directory, matches[0]) };
  });
  let password = process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD;
  const signingEnvironment = { ...process.env };
  // The signing subprocess needs no GitHub credential and performs no upload.
  delete signingEnvironment.GH_TOKEN;
  delete signingEnvironment.GITHUB_TOKEN;
  if (!signingEnvironment.TAURI_SIGNING_PRIVATE_KEY && !signingEnvironment.TAURI_SIGNING_PRIVATE_KEY_PATH) {
    if (process.platform !== 'win32') throw new Error('Set local TAURI_SIGNING_PRIVATE_KEY_PATH and its password before signing.');
    const folder = path.join(process.env.USERPROFILE, '.codex', 'secrets', 'eternal-league');
    const keyPath = path.join(folder, 'updater.key');
    if (!existsSync(keyPath)) throw new Error('The established updater signing key is missing. Do not generate a replacement.');
    const passwordPath = path.join(folder, 'updater-password.dpapi').replaceAll("'", "''");
    const decoded = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$secure = Get-Content -LiteralPath '${passwordPath}' | ConvertTo-SecureString; [Net.NetworkCredential]::new('', $secure).Password`], { encoding: 'utf8', windowsHide: true });
    if (decoded.status !== 0 || !decoded.stdout.trim()) throw new Error('The local signing password could not be decrypted. Private output withheld.');
    password = decoded.stdout.trim();
    signingEnvironment.TAURI_SIGNING_PRIVATE_KEY_PATH = keyPath;
  }
  if (!password) throw new Error('A local signing password is required.');
  signingEnvironment.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = password;
  const cli = path.join(projectRoot, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
  for (const payload of payloads) {
    const result = spawnSync(process.execPath, [cli, 'signer', 'sign', '--app-version', version, payload.file], { cwd: projectRoot, env: signingEnvironment, encoding: 'utf8', windowsHide: true });
    if (result.status !== 0) throw new Error(`Local signing failed for ${payload.name}; private output withheld.`);
    const signature = readFileSync(`${payload.file}.sig`, 'utf8').trim();
    if (!Buffer.from(signature, 'base64').toString('utf8').startsWith('untrusted comment:')) throw new Error('The signer did not produce a public minisign signature.');
    payload.signature = signature;
  }
  const changelog = readFileSync(path.join(projectRoot, 'CHANGELOG.md'), 'utf8');
  const notes = changelog.split(`## [${version}]`)[1]?.split('\n## [')[0]?.trim() ?? `Eternal League ${version}`;
  const manifest = {
    version, notes, pub_date: new Date().toISOString(),
    platforms: Object.fromEntries(payloads.map(payload => [payload.target, { signature: payload.signature, url: canonicalAssetUrl(repository, tag, payload.name) }])),
  };
  writeFileSync(path.join(directory, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Signed both ${version} installers locally and wrote latest.json. No key or password was uploaded. Verify the public signatures before attaching them to the draft.`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
