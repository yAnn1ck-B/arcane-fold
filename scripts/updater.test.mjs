import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
import ts from 'typescript';

// Exercise the same controller shipped in the UI, without a webview or a live
// installer. The release workflow runs these checks on the supported Node LTS.
const source = readFileSync(new URL('../src/services/updater-controller.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
});
const { UpdateController, UPDATE_CHECK_INTERVAL, isUpdateBlocking } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
const tick = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(overrides = {}, now = Date.now) {
  const calls = { check: 0, download: 0, install: 0, close: 0, restart: 0 };
  const handle = {
    version: '0.2.0',
    currentVersion: '0.1.0',
    body: 'A new release.',
    download: async (event) => {
      calls.download++;
      event({ event: 'Started', data: { contentLength: 100 } });
      event({ event: 'Progress', data: { chunkLength: 100 } });
      event({ event: 'Finished' });
    },
    install: async () => { calls.install++; },
    close: async () => { calls.close++; },
    ...overrides,
  };
  const adapter = {
    check: async () => { calls.check++; return handle; },
    relaunch: async () => { calls.restart++; },
  };
  return { controller: new UpdateController(adapter, now), adapter, handle, calls };
}

test('startup checks once across remounts and never downloads or installs automatically', async () => {
  const { controller, calls } = fixture();
  controller.start();
  controller.start();
  await tick();
  controller.start();
  assert.equal(calls.check, 1);
  assert.equal(controller.getSnapshot().phase, 'available');
  assert.equal(controller.getSnapshot().version, '0.2.0');
  assert.deepEqual([calls.download, calls.install, calls.restart], [0, 0, 0]);
  assert.equal(isUpdateBlocking(controller.getSnapshot()), true);
});

test('download, install and restart each require their own explicit action', async () => {
  const { controller, calls } = fixture();
  await controller.check();
  await controller.install();
  await controller.restart();
  assert.equal(calls.install, 0);
  assert.equal(calls.restart, 0);
  await controller.download();
  assert.equal(controller.getSnapshot().phase, 'downloaded');
  assert.equal(isUpdateBlocking(controller.getSnapshot()), true);
  assert.equal(controller.getSnapshot().downloadedBytes, 100);
  assert.equal(calls.install, 0);
  await controller.install();
  assert.equal(controller.getSnapshot().phase, 'installed');
  assert.equal(isUpdateBlocking(controller.getSnapshot()), true);
  assert.equal(calls.restart, 0);
  await controller.restart();
  assert.equal(calls.restart, 1);
  assert.equal(controller.getSnapshot().phase, 'restarting');
  assert.equal(isUpdateBlocking(controller.getSnapshot()), true);
});

test('a finished download event cannot enable install before signature verification resolves', async () => {
  let finish;
  const { controller, calls } = fixture({ download: async (event) => {
    event({ event: 'Finished' });
    await new Promise((resolve) => { finish = resolve; });
  } });
  await controller.check();
  const pending = controller.download();
  assert.equal(controller.getSnapshot().phase, 'downloading');
  await controller.install();
  await controller.check();
  assert.equal(isUpdateBlocking(controller.getSnapshot()), true);
  assert.equal(calls.install, 0);
  assert.equal(calls.close, 0);
  finish();
  await pending;
  assert.equal(controller.getSnapshot().phase, 'downloaded');
  assert.equal(calls.install, 0);
});

test('signature or network failures retain a mandatory update and cannot install', async () => {
  const { controller, handle, calls } = fixture({ download: async () => { throw new Error('signature mismatch'); } });
  await controller.check();
  await controller.download();
  assert.equal(controller.getSnapshot().phase, 'available');
  assert.match(controller.getSnapshot().error, /signature mismatch/);
  assert.equal(isUpdateBlocking(controller.getSnapshot()), true);
  await controller.check();
  assert.match(controller.getSnapshot().error, /signature mismatch/);
  assert.equal(calls.check, 1);
  await controller.install();
  assert.equal(calls.install, 0);
  handle.download = async () => {};
  await controller.download();
  assert.equal(controller.getSnapshot().phase, 'downloaded');
  assert.equal(controller.getSnapshot().error, null);
});

test('failed checks stay blocking and can be explicitly retried', async () => {
  const { controller, adapter, handle } = fixture();
  adapter.check = async () => { throw new Error('offline'); };
  await controller.check();
  assert.equal(controller.getSnapshot().phase, 'check-failed');
  assert.match(controller.getSnapshot().error, /offline/);
  assert.equal(isUpdateBlocking(controller.getSnapshot()), true);
  adapter.check = async () => handle;
  await controller.check();
  assert.equal(controller.getSnapshot().phase, 'available');
  assert.equal(controller.getSnapshot().error, null);
  assert.equal(isUpdateBlocking(controller.getSnapshot()), true);
});

test('a known update cannot be dismissed or rechecked away even when the server would say current', async () => {
  const { controller, adapter, calls } = fixture();
  controller.start();
  await tick();
  adapter.check = async () => { calls.check++; return null; };
  await controller.check();
  controller.start();
  assert.equal(controller.getSnapshot().phase, 'available');
  assert.equal(controller.getSnapshot().version, '0.2.0');
  assert.equal(isUpdateBlocking(controller.getSnapshot()), true);
  assert.equal(typeof controller.dismiss, 'undefined');
  assert.equal(calls.check, 1);
  assert.equal(calls.close, 0);
  await controller.download();
  assert.equal(controller.getSnapshot().phase, 'downloaded');
});

test('installer errors preserve the downloaded update for explicit retry', async () => {
  let installs = 0;
  const { controller } = fixture({ install: async () => { if (++installs === 1) throw new Error('permission denied'); } });
  await controller.check();
  await controller.download();
  await controller.install();
  assert.equal(controller.getSnapshot().phase, 'downloaded');
  assert.match(controller.getSnapshot().error, /permission denied/);
  assert.equal(isUpdateBlocking(controller.getSnapshot()), true);
  await controller.install();
  assert.equal(controller.getSnapshot().phase, 'installed');
  assert.equal(controller.getSnapshot().error, null);
  assert.equal(isUpdateBlocking(controller.getSnapshot()), true);
  assert.equal(installs, 2);
});

test('restart errors remain retryable without installing a second time', async () => {
  const { controller, adapter, calls } = fixture();
  await controller.check();
  await controller.download();
  await controller.install();
  adapter.relaunch = async () => { throw new Error('restart failed'); };
  await controller.restart();
  assert.equal(controller.getSnapshot().phase, 'installed');
  assert.match(controller.getSnapshot().error, /restart failed/);
  assert.equal(isUpdateBlocking(controller.getSnapshot()), true);
  adapter.relaunch = async () => { calls.restart++; };
  await controller.restart();
  assert.equal(calls.install, 1);
  assert.equal(calls.restart, 1);
  assert.equal(controller.getSnapshot().phase, 'restarting');
  assert.equal(isUpdateBlocking(controller.getSnapshot()), true);
});

test('concurrent clicks cannot start duplicate checks, downloads or installers', async () => {
  const { controller, calls } = fixture();
  await Promise.all([controller.check(), controller.check()]);
  await Promise.all([controller.download(), controller.download()]);
  await Promise.all([controller.install(), controller.install()]);
  await Promise.all([controller.restart(), controller.restart()]);
  assert.deepEqual([calls.check, calls.download, calls.install, calls.restart], [1, 1, 1, 1]);
});

test('a current release produces no prompt or installation work', async () => {
  const { controller, adapter, calls } = fixture();
  adapter.check = async () => null;
  await controller.check();
  await controller.download();
  await controller.install();
  assert.equal(controller.getSnapshot().phase, 'current');
  assert.equal(isUpdateBlocking(controller.getSnapshot()), false);
  assert.equal(calls.install, 0);
});

test('scheduled checks repeat every five minutes only after a completed current check', async () => {
  let now = 0;
  const { controller, adapter, handle, calls } = fixture({}, () => now);
  adapter.check = async () => { calls.check++; return null; };
  controller.start();
  await tick();
  assert.equal(UPDATE_CHECK_INTERVAL, 5 * 60 * 1000);
  assert.equal(isUpdateBlocking(controller.getSnapshot()), false);
  now = UPDATE_CHECK_INTERVAL - 1;
  await controller.poll();
  assert.equal(calls.check, 1);
  adapter.check = async () => { calls.check++; return handle; };
  now = UPDATE_CHECK_INTERVAL;
  await controller.poll();
  assert.equal(calls.check, 2);
  assert.equal(controller.getSnapshot().phase, 'available');
  assert.equal(isUpdateBlocking(controller.getSnapshot()), true);
  assert.equal(calls.install, 0);
});

test('successful background rechecks never expose a blocking phase or replace the verified session', async () => {
  let now = 0;
  const { controller, adapter, calls } = fixture({}, () => now);
  adapter.check = async () => { calls.check++; return null; };
  await controller.check();
  const result = deferred();
  const phases = [];
  const unsubscribe = controller.subscribe(() => phases.push(controller.getSnapshot().phase));
  adapter.check = async () => { calls.check++; return result.promise; };
  now = UPDATE_CHECK_INTERVAL;
  const pending = controller.poll();
  assert.equal(controller.getSnapshot().phase, 'current');
  assert.equal(isUpdateBlocking(controller.getSnapshot()), false);
  await controller.check(); // Focus/reconnect while the periodic request is pending.
  await controller.poll();
  assert.equal(calls.check, 2);
  result.resolve(null);
  await pending;
  assert.equal(isUpdateBlocking(controller.getSnapshot()), false);
  assert.ok(phases.every((phase) => phase === 'current'));
  assert.deepEqual([calls.download, calls.install, calls.restart], [0, 0, 0]);
  unsubscribe();
});

test('a discovered background update blocks immediately and remains mandatory', async () => {
  const { controller, adapter, handle, calls } = fixture();
  adapter.check = async () => { calls.check++; return null; };
  await controller.check();
  const result = deferred();
  adapter.check = async () => { calls.check++; return result.promise; };
  const pending = controller.check();
  assert.equal(isUpdateBlocking(controller.getSnapshot()), false);
  result.resolve(handle);
  await pending;
  assert.equal(controller.getSnapshot().phase, 'available');
  assert.equal(controller.getSnapshot().version, handle.version);
  assert.equal(isUpdateBlocking(controller.getSnapshot()), true);
  await controller.check();
  assert.equal(calls.check, 2);
  assert.deepEqual([calls.download, calls.install, calls.restart], [0, 0, 0]);
});

test('scheduled checks retain pending downloads and installed updates without duplicate notifications', async () => {
  let now = 0;
  const { controller, calls } = fixture({}, () => now);
  await controller.check();
  now += UPDATE_CHECK_INTERVAL;
  await controller.poll();
  assert.equal(calls.check, 1);
  await controller.download();
  now += UPDATE_CHECK_INTERVAL;
  await controller.poll();
  assert.equal(controller.getSnapshot().phase, 'downloaded');
  assert.equal(calls.check, 1);
  await controller.install();
  now += UPDATE_CHECK_INTERVAL;
  await controller.poll();
  assert.equal(controller.getSnapshot().phase, 'installed');
  assert.equal(calls.check, 1);
});

test('scheduled checks retry a failed server after the interval without looping on failures', async () => {
  let now = 0;
  const { controller, adapter, calls } = fixture({}, () => now);
  adapter.check = async () => { calls.check++; throw new Error('offline'); };
  await controller.check();
  await controller.poll();
  assert.equal(calls.check, 1);
  now = UPDATE_CHECK_INTERVAL;
  await controller.poll();
  assert.equal(calls.check, 2);
  assert.equal(controller.getSnapshot().phase, 'check-failed');
  assert.equal(isUpdateBlocking(controller.getSnapshot()), true);
});

test('idle and a pending startup network check block until the server proves the build current', async () => {
  const result = deferred();
  const { controller, adapter, calls } = fixture();
  adapter.check = async () => { calls.check++; return result.promise; };
  assert.equal(isUpdateBlocking(controller.getSnapshot()), true);
  controller.start();
  controller.start();
  await controller.check();
  assert.equal(controller.getSnapshot().phase, 'checking');
  assert.equal(isUpdateBlocking(controller.getSnapshot()), true);
  assert.equal(calls.check, 1);
  await controller.download();
  await controller.install();
  await controller.restart();
  assert.deepEqual([calls.download, calls.install, calls.restart], [0, 0, 0]);
  result.resolve(null);
  await tick();
  assert.equal(controller.getSnapshot().phase, 'current');
  assert.equal(isUpdateBlocking(controller.getSnapshot()), false);
});

test('a failed background verification blocks a previously current session until a successful retry', async () => {
  const { controller, adapter, calls } = fixture();
  adapter.check = async () => { calls.check++; return null; };
  await controller.check();
  assert.equal(isUpdateBlocking(controller.getSnapshot()), false);
  const result = deferred();
  adapter.check = async () => { calls.check++; return result.promise; };
  const pending = controller.check();
  assert.equal(controller.getSnapshot().phase, 'current');
  assert.equal(isUpdateBlocking(controller.getSnapshot()), false);
  result.reject(new Error('verification timed out'));
  await pending;
  assert.equal(controller.getSnapshot().phase, 'check-failed');
  assert.equal(isUpdateBlocking(controller.getSnapshot()), true);
  assert.match(controller.getSnapshot().error, /timed out/);
  adapter.check = async () => { calls.check++; return null; };
  await controller.check();
  assert.equal(controller.getSnapshot().phase, 'current');
  assert.equal(controller.getSnapshot().error, null);
  assert.equal(isUpdateBlocking(controller.getSnapshot()), false);
});

test('pending signature, installer and relaunch promises remain blocking and cannot trigger new checks', async () => {
  const download = deferred(), install = deferred(), restart = deferred();
  let now = 0;
  const { controller, adapter, calls } = fixture({
    download: async () => { calls.download++; await download.promise; },
    install: async () => { calls.install++; await install.promise; },
  }, () => now);
  adapter.relaunch = async () => { calls.restart++; await restart.promise; };
  await controller.check();
  const downloading = controller.download();
  now += UPDATE_CHECK_INTERVAL;
  await controller.poll();
  await controller.download();
  assert.equal(controller.getSnapshot().phase, 'downloading');
  assert.equal(isUpdateBlocking(controller.getSnapshot()), true);
  download.resolve();
  await downloading;
  const installing = controller.install();
  now += UPDATE_CHECK_INTERVAL;
  await controller.poll();
  await controller.install();
  assert.equal(controller.getSnapshot().phase, 'installing');
  assert.equal(isUpdateBlocking(controller.getSnapshot()), true);
  install.resolve();
  await installing;
  const restarting = controller.restart();
  now += UPDATE_CHECK_INTERVAL;
  await controller.poll();
  await controller.restart();
  assert.equal(controller.getSnapshot().phase, 'restarting');
  assert.equal(isUpdateBlocking(controller.getSnapshot()), true);
  restart.resolve();
  await restarting;
  assert.deepEqual([calls.check, calls.download, calls.install, calls.restart, calls.close], [1, 1, 1, 1, 0]);
});

test('late progress from a failed download cannot corrupt a newer signature-verification retry', async () => {
  let oldProgress, newProgress;
  const finished = deferred();
  const { controller, handle } = fixture({ download: async (progress) => {
    oldProgress = progress;
    throw new Error('network interrupted');
  } });
  await controller.check();
  await controller.download();
  assert.equal(isUpdateBlocking(controller.getSnapshot()), true);
  handle.download = async (progress) => { newProgress = progress; await finished.promise; };
  const retry = controller.download();
  oldProgress({ event: 'Started', data: { contentLength: 999 } });
  oldProgress({ event: 'Progress', data: { chunkLength: 999 } });
  assert.equal(controller.getSnapshot().downloadedBytes, 0);
  assert.equal(controller.getSnapshot().totalBytes, null);
  newProgress({ event: 'Started', data: { contentLength: 100 } });
  newProgress({ event: 'Progress', data: { chunkLength: 100 } });
  newProgress({ event: 'Finished' });
  assert.equal(controller.getSnapshot().phase, 'downloading');
  assert.equal(isUpdateBlocking(controller.getSnapshot()), true);
  finished.resolve();
  await retry;
  assert.equal(controller.getSnapshot().phase, 'downloaded');
  assert.equal(controller.getSnapshot().downloadedBytes, 100);
  oldProgress({ event: 'Progress', data: { chunkLength: 999 } });
  newProgress({ event: 'Progress', data: { chunkLength: 999 } });
  assert.equal(controller.getSnapshot().downloadedBytes, 100);
  assert.equal(isUpdateBlocking(controller.getSnapshot()), true);
});
