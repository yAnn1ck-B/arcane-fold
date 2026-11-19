import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { projectRoot, readVersionState, compareVersions } from './check-version.mjs';

function git(args, allowMissing = false) {
  const result = spawnSync('git', args, { cwd: projectRoot, encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' } });
  if (result.status !== 0 && !(allowMissing && result.status === 2)) throw new Error(`Git failed: ${result.stderr?.trim() || result.error?.code || result.status}`);
  return result.stdout.trim();
}
try {
  const { version } = readVersionState(), tag = `v${version}`;
  if (git(['status', '--porcelain'])) throw new Error('Commit the reviewed release before tagging; the working tree must be clean.');
  if (git(['branch', '--show-current']) !== 'main') throw new Error('Release tags must be created from main.');
  if (!/^(https:\/\/github\.com\/|git@github\.com:)yAnn1ck-B\/eternal-league(?:\.git)?$/.test(git(['remote', 'get-url', 'origin']))) throw new Error('Unexpected release repository.');
  if (!readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8').includes(`## [${version}]`)) throw new Error('Write version-specific release notes in CHANGELOG.md first.');
  const tags = git(['ls-remote', '--tags', '--refs', 'origin']).split(/\r?\n/).map(line => line.match(/refs\/tags\/v(\d+\.\d+\.\d+)$/)?.[1]).filter(Boolean);
  if (tags.some(previous => compareVersions(version, previous) <= 0)) throw new Error('This version is not newer than every existing release tag. Never replace a release tag.');
  if (git(['tag', '--list', tag])) throw new Error('The release tag already exists locally.');
  git(['push', 'origin', 'HEAD:main']);
  git(['tag', '-a', tag, '-m', `Arcane Fold ${version}`]);
  git(['push', 'origin', `refs/tags/${tag}`]);
  console.log(`Pushed ${tag}. GitHub Actions will create a draft; verify and sign both platform payloads before publishing it.`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
