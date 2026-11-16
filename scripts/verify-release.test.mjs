import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { validateRelease as validateReleaseForRepository, validateUnsignedRelease, decodePublicKey, decodeSignature, createReleaseRequest, downloadInstaller } from './verify-release.mjs';

import { canonicalAssetUrl, findDraftRelease } from './release-assets.mjs';

function validateRelease(release, assets, manifest, tag, published = false) {
  return validateReleaseForRepository(release, assets, manifest, tag, published, 'owner/repo');
}

function fixture() {
  const release = { tag_name: 'v0.2.0', draft: true, prerelease: false };
  const assets = [
    ['Eternal.League_0.2.0_x64-setup.exe', 1], ['Eternal.League_0.2.0_x64-setup.exe.sig', 2],
    ['Eternal.League_0.2.0_amd64.AppImage', 3], ['Eternal.League_0.2.0_amd64.AppImage.sig', 4], ['latest.json', 5],
  ].map(([name,id]) => ({ name, id, size: 100, url: `https://api.github.com/repos/owner/repo/releases/assets/${id}`, browser_download_url: `https://github.com/owner/repo/releases/download/v0.2.0/${name}` }));
  const manifest = { version: '0.2.0', platforms: { 'windows-x86_64': { url: assets[0].browser_download_url, signature: 'signed-windows' }, 'linux-x86_64': { url: assets[2].browser_download_url, signature: 'signed-linux' } } };
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

async function serve(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test("draft installers download through authenticated asset API and follow binary redirects", async (t) => {
  const bytes = Buffer.from("MZ-private-installer");
  const apiRequests = [],
    redirectedRequests = [];
  const storage = await serve(t, (request, response) => {
    redirectedRequests.push({
      url: request.url,
      authorization: request.headers.authorization,
    });
    response.end(bytes);
  });
  const api = await serve(t, (request, response) => {
    apiRequests.push({
      url: request.url,
      authorization: request.headers.authorization,
      accept: request.headers.accept,
    });
    if (request.url !== "/assets/1") {
      response.writeHead(404);
      response.end();
      return;
    }
    if (
      request.headers.authorization !== "Bearer fixture-token" ||
      request.headers.accept !== "application/octet-stream"
    ) {
      response.writeHead(403);
      response.end();
      return;
    }
    response.writeHead(302, { Location: `${storage}/signed-payload` });
    response.end();
  });
  const result = await downloadInstaller(
    { url: `${api}/assets/1` },
    { url: `${api}/browser/installer.exe` },
    false,
    createReleaseRequest(false, "fixture-token"),
  );
  assert.deepEqual(result, bytes);
  assert.deepEqual(apiRequests, [
    {
      url: "/assets/1",
      authorization: "Bearer fixture-token",
      accept: "application/octet-stream",
    },
  ]);
  assert.deepEqual(redirectedRequests, [
    { url: "/signed-payload", authorization: undefined },
  ]);
});

test("published installer verification uses public manifest URL without authentication", async (t) => {
  const bytes = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1]);
  const requests = [];
  const host = await serve(t, (request, response) => {
    requests.push({
      url: request.url,
      authorization: request.headers.authorization,
      accept: request.headers.accept,
    });
    if (
      request.url !== "/public/installer.AppImage" ||
      request.headers.authorization !== undefined
    ) {
      response.writeHead(403);
      response.end();
      return;
    }
    response.end(bytes);
  });
  const result = await downloadInstaller(
    { url: `${host}/assets/1` },
    { url: `${host}/public/installer.AppImage` },
    true,
    createReleaseRequest(true, "fixture-token"),
  );
  assert.deepEqual(result, bytes);
  assert.deepEqual(requests, [
    {
      url: "/public/installer.AppImage",
      authorization: undefined,
      accept: "application/octet-stream",
    },
  ]);
});

test("updater manifest must use matching public browser URL rather than authenticated asset API", () => {
  const { release, assets, manifest } = fixture();
  manifest.platforms["windows-x86_64"].url = assets[0].url;
  assert.throws(
    () => validateRelease(release, assets, manifest, "v0.2.0"),
    /windows/,
  );
  assert.throws(
    () =>
      validateRelease(
        { ...release, draft: false },
        assets,
        manifest,
        "v0.2.0",
        true,
      ),
    /windows/,
  );
});


test('canonical asset URLs use the final tag and exact GitHub asset name', () => {
  assert.equal(canonicalAssetUrl('owner/repo', 'v0.2.0', 'Eternal.League_0.2.0_x64-setup.exe'), 'https://github.com/owner/repo/releases/download/v0.2.0/Eternal.League_0.2.0_x64-setup.exe');
  assert.equal(canonicalAssetUrl('owner/repo', 'v0.2.0', 'asset #1.sig'), 'https://github.com/owner/repo/releases/download/v0.2.0/asset%20%231.sig');
  assert.throws(() => canonicalAssetUrl('owner/repo', 'untagged-123', 'asset.exe'), /tag/);
  assert.throws(() => canonicalAssetUrl('owner/repo', 'v0.2.0', '../asset.exe'), /separators/);
});

test('draft temporary browser URLs never enter the manifest and published URLs must match', () => {
  const { release, assets, manifest } = fixture();
  for (const asset of assets) asset.browser_download_url = asset.browser_download_url.replace('/v0.2.0/', '/untagged-056331ca5fe677dc5419/');
  assert.equal(validateRelease(release, assets, manifest, 'v0.2.0').length, 2);
  assert.throws(() => validateRelease({ ...release, draft: false }, assets, manifest, 'v0.2.0', true), /Published download URL/);
  manifest.platforms['windows-x86_64'].url = assets[0].browser_download_url;
  assert.throws(() => validateRelease(release, assets, manifest, 'v0.2.0'), /windows/);
  manifest.platforms['windows-x86_64'].url = canonicalAssetUrl('owner/repo', 'v0.2.0', assets[0].name.replace('Eternal.League', 'Eternal League'));
  assert.throws(() => validateRelease(release, assets, manifest, 'v0.2.0'), /windows/);
});

test('attachment finds the matching draft through release listing when tag API returns 404', () => {
  const draft = { tag_name: 'v0.2.0', draft: true, id: 123 };
  const requests = [];
  const result = findDraftRelease('owner/repo', 'v0.2.0', args => {
    requests.push(args);
    if (requests.length === 1) throw new Error('GitHub CLI failed (1): gh: Not Found (HTTP 404)');
    return JSON.stringify([{ tag_name: 'v0.1.0', draft: true }, draft]);
  });
  assert.deepEqual(result, draft);
  assert.deepEqual(requests, [
    ['api', 'repos/owner/repo/releases/tags/v0.2.0'],
    ['api', 'repos/owner/repo/releases?per_page=100'],
  ]);
});

test('attachment lookup never treats authorization failures or published releases as a draft', () => {
  let calls = 0;
  assert.throws(() => findDraftRelease('owner/repo', 'v0.2.0', () => { calls++; throw new Error('Forbidden (HTTP 403)'); }), /403/);
  assert.equal(calls, 1);
  assert.throws(() => findDraftRelease('owner/repo', 'v0.2.0', () => JSON.stringify({ tag_name: 'v0.2.0', draft: false })), /immutable/);
  assert.throws(() => findDraftRelease('owner/repo', 'v0.2.0', args => { if (args[1].includes('/tags/')) throw new Error('Not Found (HTTP 404)'); return '[]'; }), /not found/);
});
