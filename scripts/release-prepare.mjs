import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { nextVersion, readVersionState, projectRoot } from './check-version.mjs';

try {
  if (process.argv.length > 3) throw new Error('Usage: release-prepare.mjs [patch|minor|major|X.Y.Z]');
  const { version: current } = readVersionState();
  const version = nextVersion(current, process.argv[2] ?? 'patch');
  for (const file of ['package.json', 'package-lock.json', 'src-tauri/tauri.conf.json']) {
    const target = path.join(projectRoot, file), data = JSON.parse(readFileSync(target, 'utf8'));
    data.version = version;
    if (file === 'package-lock.json') data.packages[''].version = version;
    writeFileSync(target, `${JSON.stringify(data, null, 2)}\n`);
  }
  const manifest = path.join(projectRoot, 'src-tauri/Cargo.toml');
  writeFileSync(manifest, readFileSync(manifest, 'utf8').replace(/(\[package\][\s\S]*?\nversion\s*=\s*")[^"]+(".*)/, `$1${version}$2`));
  const lock = path.join(projectRoot, 'src-tauri/Cargo.lock');
  writeFileSync(lock, readFileSync(lock, 'utf8').replace(/(\[\[package\]\]\s*\nname = "eternal-league"\s*\nversion = ")[^"]+(".*)/, `$1${version}$2`));
  readVersionState();
  console.log(`Prepared ${current} -> ${version}. Update CHANGELOG.md, run all checks, then commit before release:tag. The shared league start was preserved.`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
