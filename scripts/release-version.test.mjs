import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compareVersions, nextVersion, validateVersionValues } from './check-version.mjs';

test('every release advances stable SemVer without lexical ordering mistakes', () => {
  assert.equal(nextVersion('0.2.9'), '0.2.10');
  assert.equal(nextVersion('0.2.9', 'minor'), '0.3.0');
  assert.equal(nextVersion('0.2.9', 'major'), '1.0.0');
  assert.equal(nextVersion('0.2.9', '0.4.1'), '0.4.1');
  assert.equal(compareVersions('0.2.10', '0.2.9'), 1);
  for (const requested of ['0.2.9', '0.1.0', 'v0.3.0', '0.3', '01.3.0', '0.3.0-beta']) assert.throws(() => nextVersion('0.2.9', requested));
});
test('mismatched manifests or tags stop release preparation', () => {
  assert.equal(validateVersionValues({ npm: '0.2.0', cargo: '0.2.0' }, 'v0.2.0'), '0.2.0');
  assert.throws(() => validateVersionValues({ npm: '0.2.0', cargo: '0.1.0' }));
  assert.throws(() => validateVersionValues({ npm: '0.2.0', cargo: '0.2.0' }, 'v0.2.1'));
  assert.throws(() => validateVersionValues({ npm: '0.2.0', cargo: undefined }));
});

test('ordinary dev uses the played profile and calendar; explicit QA and release launches keep their settings', t => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'league-launch-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const scripts = path.join(workspace, 'scripts');
  const cli = path.join(workspace, 'node_modules', '@tauri-apps', 'cli');
  mkdirSync(scripts);
  mkdirSync(cli, { recursive: true });
  const wrapper = path.join(scripts, 'tauri.mjs');
  copyFileSync(new URL('./tauri.mjs', import.meta.url), wrapper);
  writeFileSync(path.join(cli, 'tauri.js'), 'console.log(JSON.stringify([process.argv.slice(2), process.env.ETERNAL_LEAGUE_PREVIEW_WEEKS ?? null]));');
  const env = { ...process.env };
  delete env.ETERNAL_LEAGUE_PREVIEW_WEEKS;
  const launch = (...args) => JSON.parse(execFileSync(process.execPath, [wrapper, ...args], { env, encoding: 'utf8' }));
  const config = path.join(workspace, 'src-tauri', 'tauri.dev.conf.json');
  assert.deepEqual(launch('dev', '--', '--locked'), [['dev', '--config', config, '--', '--locked'], '4']);
  for (const flags of [['--config', 'qa.json'], ['-cqa.json'], ['--config=qa.json']]) {
    assert.deepEqual(launch('dev', ...flags), [['dev', ...flags], null]);
  }
  assert.deepEqual(launch('build'), [['build'], null]);
  env.ETERNAL_LEAGUE_PREVIEW_WEEKS = '0';
  assert.deepEqual(launch('dev'), [['dev', '--config', config], '0']);
});
