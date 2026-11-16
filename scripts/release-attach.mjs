import { readFileSync } from 'node:fs';
import path from 'node:path';
import { readVersionState, projectRoot } from './check-version.mjs';
import { repository, runGithub } from './github.mjs';
import { validateUnsignedRelease } from './verify-release.mjs';
import { canonicalAssetUrl, findDraftRelease } from './release-assets.mjs';

try {
  const { version } = readVersionState(), tag = process.argv[2] ?? `v${version}`;
  if (tag !== `v${version}` || process.argv.length > 4) throw new Error(`Usage: release-attach.mjs [v${version}] [directory]`);
  const directory = path.resolve(process.argv[3] ?? path.join(projectRoot, '.verification', 'releases', tag));
  const release = findDraftRelease(repository, tag, runGithub);
  if (!release.draft) throw new Error('Published releases are immutable. Create a higher version instead.');
  const plan = validateUnsignedRelease(release, release.assets.filter(asset => asset.name.endsWith('.exe') || asset.name.endsWith('.AppImage')), tag);
  const manifestPath = path.join(directory, 'latest.json'), manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.version !== version || Object.keys(manifest.platforms ?? {}).sort().join() !== 'linux-x86_64,windows-x86_64') throw new Error('The local manifest does not match both release platforms.');
  const files = [];
  for (const { platform, payload } of plan) {
    const signaturePath = path.join(directory, `${payload.name}.sig`);
    const signature = readFileSync(signaturePath, 'utf8').trim();
    const decoded = Buffer.from(signature, 'base64').toString('utf8');
    if (signature.length > 16000 || !decoded.startsWith('untrusted comment:') || !decoded.includes('trusted comment:')) throw new Error('Only public updater signatures can be uploaded.');
    if (manifest.platforms[platform]?.signature !== signature || manifest.platforms[platform]?.url !== canonicalAssetUrl(repository, tag, payload.name)) throw new Error('Manifest signature/URL does not match the draft payload.');
    files.push(signaturePath);
  }
  runGithub(['release', 'upload', tag, ...files, manifestPath, '--repo', repository, '--clobber']);
  console.log('Uploaded only public signatures and latest.json to the draft. Run full cryptographic verification before publishing.');
} catch (error) { console.error(error.message); process.exitCode = 1; }
