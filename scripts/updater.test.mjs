import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
import ts from 'typescript';

// Exercise the same controller shipped in the UI, without a webview or a live
// installer. This runs on the Node 20 version already used by the project.
const source = readFileSync(new URL('../src/services/updater-controller.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
});
const { UpdateController, UPDATE_CHECK_INTERVAL } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
const tick = () => new Promise((resolve) => setImmediate(resolve));

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
  assert.equal(controller.getSnapshot().downloadedBytes, 100);
  assert.equal(calls.install, 0);
  await controller.install();
  assert.equal(controller.getSnapshot().phase, 'installed');
  assert.equal(calls.restart, 0);
  await controller.restart();
  assert.equal(calls.restart, 1);
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
  await controller.dismiss();
  assert.equal(calls.install, 0);
  assert.equal(calls.close, 0);
  finish();
  await pending;
  assert.equal(controller.getSnapshot().phase, 'downloaded');
  assert.equal(calls.install, 0);
});

test('signature or network failures remain nonblocking and cannot install', async () => {
  const { controller, handle, calls } = fixture({ download: async () => { throw new Error('signature mismatch'); } });
  await controller.check();
  await controller.download();
  assert.equal(controller.getSnapshot().phase, 'available');
  assert.match(controller.getSnapshot().error, /signature mismatch/);
  await controller.install();
  assert.equal(calls.install, 0);
  handle.download = async () => {};
  await controller.download();
  assert.equal(controller.getSnapshot().phase, 'downloaded');
  assert.equal(controller.getSnapshot().error, null);
});

test('failed checks can be retried without blocking the league', async () => {
  const { controller, adapter, handle } = fixture();
  adapter.check = async () => { throw new Error('offline'); };
  await controller.check();
  assert.equal(controller.getSnapshot().phase, 'check-failed');
  assert.match(controller.getSnapshot().error, /offline/);
  adapter.check = async () => handle;
  await controller.check();
  assert.equal(controller.getSnapshot().phase, 'available');
  assert.equal(controller.getSnapshot().error, null);
});

test('dismissal releases native resources and stays dismissed during the session', async () => {
  const { controller, calls } = fixture();
  controller.start();
  await tick();
  await controller.download();
  await controller.dismiss();
  controller.start();
  await controller.download();
  await controller.install();
  assert.equal(controller.getSnapshot().phase, 'dismissed');
  assert.equal(calls.close, 1);
  assert.equal(calls.check, 1);
  assert.equal(calls.install, 0);
});

test('installer errors preserve the downloaded update for explicit retry', async () => {
  let installs = 0;
  const { controller } = fixture({ install: async () => { if (++installs === 1) throw new Error('permission denied'); } });
  await controller.check();
  await controller.download();
  await controller.install();
  assert.equal(controller.getSnapshot().phase, 'downloaded');
  assert.match(controller.getSnapshot().error, /permission denied/);
  await controller.install();
  assert.equal(controller.getSnapshot().phase, 'installed');
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
  adapter.relaunch = async () => { calls.restart++; };
  await controller.restart();
  assert.equal(calls.install, 1);
  assert.equal(calls.restart, 1);
});

test('concurrent clicks cannot start duplicate checks, downloads or installers', async () => {
  const { controller, calls } = fixture();
  await Promise.all([controller.check(), controller.check()]);
  await Promise.all([controller.download(), controller.download()]);
  await Promise.all([controller.install(), controller.install()]);
  assert.deepEqual([calls.check, calls.download, calls.install], [1, 1, 1]);
});

test('a current release produces no prompt or installation work', async () => {
  const { controller, adapter, calls } = fixture();
  adapter.check = async () => null;
  await controller.check();
  await controller.download();
  await controller.install();
  assert.equal(controller.getSnapshot().phase, 'current');
  assert.equal(calls.install, 0);
});

test('scheduled checks repeat every four hours and remind later only after a full interval', async () => {
  let now = 0;
  const { controller, calls } = fixture({}, () => now);
  controller.start();
  await tick();
  now = UPDATE_CHECK_INTERVAL - 1000;
  await controller.dismiss();
  now = UPDATE_CHECK_INTERVAL;
  await controller.poll();
  assert.equal(calls.check, 1);
  now = 2 * UPDATE_CHECK_INTERVAL;
  await controller.poll();
  assert.equal(calls.check, 2);
  assert.equal(controller.getSnapshot().phase, 'available');
  assert.equal(calls.install, 0);
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
});
