import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { repository as defaultRepository } from './github.mjs';

const targets = [['windows-x86_64', '.exe'], ['linux-x86_64', '.AppImage']];

export function validateRelease(release, assets, manifest, tag, published = false) {
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error('Use an exact vX.Y.Z release tag.');
  if (release?.tag_name !== tag || release.draft !== !published) throw new Error(published ? 'The tagged release must be published.' : 'The tagged release must remain a draft.');
  if (release.prerelease) throw new Error('Stable updater releases cannot be prereleases.');
  if (manifest?.version !== tag.slice(1)) throw new Error('Updater version does not match the release tag.');
  const names = new Set();
  for (const asset of assets) {
    if (names.has(asset.name)) throw new Error('The release contains duplicate asset names.');
    names.add(asset.name);
  }
  const allowed = new Set(['latest.json']);
  const plan = targets.map(([platform, extension]) => {
    const entry = manifest.platforms?.[platform];
    const payload = assets.find((asset) => asset.url === entry?.url || asset.browser_download_url === entry?.url);
    if (!payload || !payload.name.endsWith(extension) || payload.size < 1 || !payload.name.includes(tag.slice(1))) throw new Error(`Missing versioned installer for ${platform}.`);
    if (/[\\/\0]/.test(payload.name)) throw new Error('Installer filenames cannot contain path separators.');
    const signature = assets.find((asset) => asset.name === `${payload.name}.sig` && asset.size > 0);
    if (!signature || typeof entry.signature !== 'string' || !entry.signature.trim()) throw new Error(`Missing updater signature for ${platform}.`);
    allowed.add(payload.name); allowed.add(signature.name);
    return { platform, payload, signature, entry };
  });
  for (const asset of assets) {
    if (!allowed.has(asset.name)) throw new Error(`Unexpected release asset: ${asset.name}. Only installers, signatures, and latest.json are allowed.`);
  }
  if (assets.length !== 5 || !assets.some((asset) => asset.name === 'latest.json' && asset.size > 0)) throw new Error('Both installers, both signatures, and latest.json are required.');
  return plan;
}

export function validateUnsignedRelease(release, assets, tag) {
  if (!/^v\d+\.\d+\.\d+$/.test(tag) || release?.tag_name !== tag || !release.draft || release.prerelease) throw new Error('Unsigned installers require an exact stable draft release tag.');
  const plan = targets.map(([platform, extension]) => {
    const matches = assets.filter((asset) => asset.name.endsWith(extension) && asset.name.includes(tag.slice(1)) && asset.size > 0);
    if (matches.length !== 1) throw new Error(`Exactly one versioned installer is required for ${platform}.`);
    return { platform, payload: matches[0] };
  });
  if (assets.length !== 2) throw new Error('An unsigned draft may contain only the Windows and Linux installers.');
  return plan;
}

export function decodePublicKey(encoded) {
  const text = Buffer.from(encoded ?? '', 'base64').toString('utf8');
  const lines = text.trim().split(/\r?\n/);
  if (!lines[0]?.startsWith('untrusted comment:') || !/^[A-Za-z0-9+/]{56}$/.test(lines[1] ?? '') || Buffer.from(lines[1], 'base64').length !== 42) throw new Error('The configured Tauri updater public key is invalid.');
  return lines[1];
}

export function decodeSignature(encoded, expectedVersion) {
  const text = Buffer.from(encoded.trim(), 'base64').toString('utf8');
  if (!text.startsWith('untrusted comment:') || !text.split(/\r?\n/).some((line) => line.startsWith('trusted comment:'))) throw new Error('The updater signature is not a Tauri/minisign signature.');
  if (expectedVersion !== undefined) {
    const trusted = text.split(/\r?\n/).find((line) => line.startsWith('trusted comment:'));
    const versions = trusted.split('\t').filter((field) => field.startsWith('version:'));
    if (versions.length !== 1 || versions[0] !== `version:${expectedVersion}`) throw new Error('The signed updater version is missing or differs from the release version.');
  }
  return text;
}

async function verifyRelease(tag, published, unsigned = false) {
  const repository = process.env.GITHUB_REPOSITORY ?? defaultRepository;
  if (!repository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('GITHUB_REPOSITORY must identify the release repository.');
  const apiBase = `${process.env.GITHUB_API_URL ?? 'https://api.github.com'}/repos/${repository}`;
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (!published && !token) throw new Error('GH_TOKEN or GITHUB_TOKEN is required to verify draft releases.');
  async function request(url, kind = 'json', allowMissing = false) {
    const headers = { Accept: kind === 'json' ? 'application/vnd.github+json' : 'application/octet-stream', 'X-GitHub-Api-Version': '2022-11-28' };
    // Published verification deliberately uses no authorization, including downloads.
    if (!published && token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(kind === 'bytes' ? 300_000 : 60_000) });
    if (allowMissing && response.status === 404) return null;
    if (!response.ok) throw new Error(`Release verification failed: HTTP ${response.status}.`);
    if (kind === 'bytes') return Buffer.from(await response.arrayBuffer());
    if (kind === 'text') return response.text();
    return response.json();
  }
  let release = await request(`${apiBase}/releases/tags/${encodeURIComponent(tag)}`, 'json', true);
  if (!release) {
    const releases = await request(`${apiBase}/releases?per_page=100`);
    release = releases.find((item) => item.tag_name === tag);
  }
  if (!release) throw new Error('The tagged release was not found.');
  const assets = await request(`${apiBase}/releases/${release.id}/assets?per_page=100`);
  if (unsigned) {
    if (published) throw new Error('Unsigned verification cannot publish a release.');
    validateUnsignedRelease(release, assets, tag);
    console.log('Both unsigned draft installers are ready for local signing. Do not publish before full signature verification.');
    return;
  }
  const manifestAsset = assets.find((asset) => asset.name === 'latest.json');
  if (!manifestAsset) throw new Error('latest.json is missing.');
  const config = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'));
  let manifest;
  if (published) {
    const endpoint = config.plugins?.updater?.endpoints?.[0];
    if (!endpoint?.startsWith('https://')) throw new Error('A public HTTPS updater endpoint is required.');
    manifest = JSON.parse(await request(endpoint, 'text'));
  } else {
    manifest = JSON.parse(await request(manifestAsset.url, 'text'));
  }
  const plan = validateRelease(release, assets, manifest, tag, published);
  const publicKey = decodePublicKey(config.plugins?.updater?.pubkey);
  const directory = mkdtempSync(path.join(tmpdir(), 'eternal-league-release-'));
  try {
    for (const { platform, payload, signature, entry } of plan) {
      if (payload.size > 512 * 1024 * 1024) throw new Error(`Installer exceeds the verification size limit for ${platform}.`);
      const signed = await request(signature.url, 'text');
      if (signed.trim() !== entry.signature.trim()) throw new Error(`Manifest and uploaded signature differ for ${platform}.`);
      const payloadFile = path.join(directory, platform);
      const signatureFile = `${payloadFile}.minisig`;
      const bytes = await request(entry.url, 'bytes');
      if (bytes.length !== payload.size) throw new Error(`Installer download size differs for ${platform}.`);
      const magic = bytes.subarray(0, platform.startsWith('windows') ? 2 : 4);
      if (platform.startsWith('windows') ? magic.toString('ascii') !== 'MZ' : !magic.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) throw new Error(`Installer is not a native executable for ${platform}.`);
      writeFileSync(payloadFile, bytes);
      writeFileSync(signatureFile, decodeSignature(signed, tag.slice(1)));
      const checked = spawnSync(process.env.MINISIGN_EXECUTABLE ?? 'minisign', ['-Vm', payloadFile, '-x', signatureFile, '-P', publicKey], { encoding: 'utf8' });
      if (checked.error) throw new Error('minisign is required for cryptographic release verification. Install it from the operating system package repository.');
      if (checked.status !== 0) throw new Error(`Cryptographic updater signature verification failed for ${platform}.`);
      console.log(`Verified ${platform} installer and updater signature${published ? ' anonymously' : ''}.`);
    }
  } finally {
    const relative = path.relative(path.resolve(tmpdir()), path.resolve(directory));
    if (!relative.startsWith('..') && !path.isAbsolute(relative) && path.basename(directory).startsWith('eternal-league-release-')) rmSync(directory, { recursive: true, force: true });
  }
  console.log(published ? 'Published installers and public updater endpoint are verified.' : 'Both signed installers and latest.json are verified. The release is still a draft.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const tagIndex = args.indexOf('--tag');
  const tag = tagIndex >= 0 ? args[tagIndex + 1] : undefined;
  if (!tag || args.some((arg, index) => arg !== '--tag' && arg !== '--published' && arg !== '--unsigned' && index !== tagIndex + 1)) {
    console.error('Usage: node scripts/verify-release.mjs --tag vX.Y.Z [--published | --unsigned]');
    process.exitCode = 1;
  } else {
    verifyRelease(tag, args.includes('--published'), args.includes('--unsigned')).catch((error) => { console.error(error.message); process.exitCode = 1; });
  }
}
