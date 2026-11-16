import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRelease, validateUnsignedRelease, decodePublicKey, decodeSignature } from './verify-release.mjs';

function fixture() {
  const release = { tag_name: 'v0.2.0', draft: true, prerelease: false };
  const assets = [
    ['Eternal.League_0.2.0_x64-setup.exe', 1], ['Eternal.League_0.2.0_x64-setup.exe.sig', 2],
    ['Eternal.League_0.2.0_amd64.AppImage', 3], ['Eternal.League_0.2.0_amd64.AppImage.sig', 4], ['latest.json', 5],
  ].map(([name,id]) => ({ name, id, size: 100, url: `https://api.github.com/repos/owner/repo/releases/assets/${id}`, browser_download_url: `https://github.com/owner/repo/releases/download/v0.2.0/${name}` }));
  const manifest = { version: '0.2.0', platforms: { 'windows-x86_64': { url: assets[0].url, signature: 'signed-windows' }, 'linux-x86_64': { url: assets[2].url, signature: 'signed-linux' } } };
  return { release, assets, manifest };
}

test('draft verification requires both platform installers and their signatures', () => {
  const { release, assets, manifest } = fixture();
  assert.equal(validateRelease(release, assets, manifest, 'v0.2.0').length, 2);
  assert.throws(() => validateRelease(release, assets.filter((asset) => !asset.name.endsWith('.AppImage.sig')), manifest, 'v0.2.0'), /signature/);
  delete manifest.platforms['linux-x86_64'];
  assert.throws(() => validateRelease(release, assets, manifest, 'v0.2.0'), /linux/);
});

test('version mismatch, wrong release state, and prerelease cannot pass', () => {
  const { release, assets, manifest } = fixture();
  assert.throws(() => validateRelease(release, assets, manifest, 'v0.3.0'), /draft/);
  assert.throws(() => validateRelease(release, assets, { ...manifest, version: '0.3.0' }, 'v0.2.0'), /version/);
  assert.throws(() => validateRelease({ ...release, draft: false }, assets, manifest, 'v0.2.0'), /draft/);
  assert.throws(() => validateRelease({ ...release, prerelease: true }, assets, manifest, 'v0.2.0'), /prereleases/);
  assert.equal(validateRelease({ ...release, draft: false }, assets, manifest, 'v0.2.0', true).length, 2);
});

test('unknown URLs and development databases are rejected', () => {
  const { release, assets, manifest } = fixture();
  manifest.platforms['windows-x86_64'].url = 'https://unrelated.example/unsigned.exe';
  assert.throws(() => validateRelease(release, assets, manifest, 'v0.2.0'), /windows/);
  manifest.platforms['windows-x86_64'].url = assets[0].browser_download_url;
  assert.throws(() => validateRelease(release, [...assets, { name: 'eternal-league.db', size: 1 }], manifest, 'v0.2.0'), /Unexpected release asset/);
});

test('Tauri base64 wrapping is decoded for minisign without accepting malformed keys', () => {
  const key = Buffer.alloc(42, 1).toString('base64');
  assert.equal(decodePublicKey(Buffer.from(`untrusted comment: public key\n${key}\n`).toString('base64')), key);
  assert.throws(() => decodePublicKey('not-a-public-key'), /public key/);
  const signature = 'untrusted comment: signature\nabc\ntrusted comment: timestamp:1\ndef\n';
  assert.equal(decodeSignature(Buffer.from(signature).toString('base64')), signature);
  assert.throws(() => decodeSignature(Buffer.from('invalid').toString('base64')), /signature/);
});

test('local-signing mode accepts exactly two unsigned draft payloads without secrets', () => {
  const { release, assets } = fixture();
  const payloads = assets.filter((asset) => asset.name.endsWith('.exe') || asset.name.endsWith('.AppImage'));
  assert.equal(validateUnsignedRelease(release, payloads, 'v0.2.0').length, 2);
  assert.throws(() => validateUnsignedRelease(release, payloads.slice(0, 1), 'v0.2.0'), /linux/);
  assert.throws(() => validateUnsignedRelease(release, [...payloads, { name: 'profile.db', size: 1 }], 'v0.2.0'), /only/);
  assert.throws(() => validateUnsignedRelease({ ...release, draft: false }, payloads, 'v0.2.0'), /draft/);
});

test('signed updater versions must be present in the authenticated TAB-separated trusted comment', () => {
  const encode = (comment) => Buffer.from(`untrusted comment: signature\nabc\ntrusted comment: ${comment}\ndef\n`).toString('base64');
  assert.match(decodeSignature(encode('timestamp:1\tfile:installer.exe\tversion:0.2.0'), '0.2.0'), /version:0.2.0/);
  assert.throws(() => decodeSignature(encode('timestamp:1\tfile:installer.exe'), '0.2.0'), /version/);
  assert.throws(() => decodeSignature(encode('timestamp:1\tfile:installer.exe\tversion:0.1.0'), '0.2.0'), /version/);
  assert.throws(() => decodeSignature(encode('timestamp:1\tversion:0.2.0\tversion:0.2.0'), '0.2.0'), /version/);
});
