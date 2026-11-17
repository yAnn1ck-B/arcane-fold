import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../src/lib/deck-autosave.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
});
const { CollectionAddBases, DeckAutosave } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const draft = (quantity = 1, id = null, name = 'Named deck', cardId = 'front') => ({
  id, name, cards: quantity ? [{ cardId, section: 'main', quantity }] : [],
});
const detail = (request, id = request.id ?? 'created-id') => ({
  ...request, id, createdAt: 'today', updatedAt: 'today',
});
function fixture(save) {
  const calls = [], tokens = [], states = [], acks = [];
  const queue = new DeckAutosave(async (value, token) => {
    calls.push(structuredClone(value));
    tokens.push(token);
    return save ? save(value, calls.length, token) : detail(value);
  }, (state) => states.push(state), (ack) => acks.push(ack), 0);
  return { queue, calls, tokens, states, acks };
}

test('opening the editor and an unnamed first edit never create a junk deck', async () => {
  const { queue, calls, states } = fixture();
  queue.reset({ id: null, name: '', cards: [] });
  await tick();
  assert.equal(calls.length, 0);
  queue.edit(draft(1, null, ''));
  await tick();
  assert.equal(calls.length, 0);
  assert.equal(states.at(-1).phase, 'unnamed');
  await assert.rejects(queue.flush(), /Name this deck/);
  queue.edit(draft(1, null, 'My first deck'));
  await queue.flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'My first deck');
});

test('rapid edits serialize a first create and reuse its assigned ID for the newest snapshot', async () => {
  const first = deferred();
  let active = 0, maximum = 0;
  const { queue, calls } = fixture(async (value, count) => {
    maximum = Math.max(maximum, ++active);
    const result = count === 1 ? await first.promise : detail(value);
    active--;
    return result;
  });
  queue.edit(draft(1));
  const flushing = queue.flush();
  queue.edit(draft(2));
  queue.edit(draft(3));
  assert.equal(calls.length, 1);
  first.resolve(detail(calls[0], 'one-logical-deck'));
  await flushing;
  assert.equal(maximum, 1);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].id, null);
  assert.equal(calls[1].id, 'one-logical-deck');
  assert.equal(calls[1].cards[0].quantity, 3);
  assert.equal(queue.getDraft().id, 'one-logical-deck');
});

test('a stale response acknowledges identity without erasing a later name or printing change', async () => {
  const first = deferred();
  const { queue, calls, acks } = fixture((value, count) => count === 1 ? first.promise : detail(value));
  queue.reset(draft(1, 'existing'));
  queue.edit(draft(2, 'existing'));
  const flushing = queue.flush();
  queue.edit(draft(2, 'existing', 'Renamed', 'alternate-printing'));
  first.resolve(detail(calls[0]));
  await flushing;
  assert.deepEqual(acks.map((ack) => ack.current), [false, true]);
  assert.equal(queue.getDraft().name, 'Renamed');
  assert.equal(queue.getDraft().cards[0].cardId, 'alternate-printing');
  assert.equal(calls[1].name, 'Renamed');
});

test('a save error pauses without a retry loop and explicit Retry sends only the latest draft', async () => {
  const { queue, calls, states } = fixture((value, count) => {
    if (count === 1) throw new Error('Forge folder unavailable');
    return detail(value);
  });
  queue.reset(draft(1, 'existing'));
  queue.edit(draft(2, 'existing'));
  await assert.rejects(queue.flush(), /Forge folder unavailable/);
  await tick();
  await tick();
  assert.equal(calls.length, 1);
  assert.equal(states.at(-1).phase, 'error');
  assert.equal(queue.getDraft().cards[0].quantity, 2);
  await queue.flush();
  assert.equal(calls.length, 2);
  assert.equal(states.at(-1).pending, false);
});

test('a new edit resumes a failed queue once without replaying obsolete intermediate drafts', async () => {
  const { queue, calls } = fixture((value, count) => {
    if (count === 1) throw new Error('temporary failure');
    return detail(value);
  });
  queue.edit(draft(1));
  await assert.rejects(queue.flush());
  queue.edit(draft(2));
  queue.edit(draft(4));
  await queue.flush();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].cards[0].quantity, 4);
});

test('a failed transition flush leaves the current editor session untouched', async () => {
  const { queue } = fixture(() => { throw new Error('permission denied'); });
  queue.reset(draft(1, 'current'));
  queue.edit(draft(3, 'current'));
  await assert.rejects(async () => {
    await queue.flush();
    queue.reset(draft(1, 'other'));
  }, /permission denied/);
  assert.equal(queue.getDraft().id, 'current');
  assert.equal(queue.getDraft().cards[0].quantity, 3);
});

test('suspending deletion waits for an active save and cancels the buffered follow-up', async () => {
  const first = deferred();
  const { queue, calls } = fixture(() => first.promise);
  queue.reset(draft(1, 'existing'));
  queue.edit(draft(2, 'existing'));
  const saving = queue.flush().catch((error) => error);
  queue.edit(draft(3, 'existing'));
  let settled = false;
  const deleting = queue.suspend().then(() => { settled = true; });
  await tick();
  assert.equal(settled, false);
  first.resolve(detail(calls[0]));
  await deleting;
  queue.reset({ id: null, name: '', cards: [] });
  await saving;
  await tick();
  assert.equal(calls.length, 1);
  assert.equal(queue.getDraft().id, null);
});

test('session invalidation ignores old acknowledgements and still serializes a replacement', async () => {
  const first = deferred();
  const { queue, calls, acks } = fixture((value, count) => count === 1 ? first.promise : detail(value));
  queue.edit(draft(1));
  const saving = queue.flush();
  queue.reset(draft(1, 'replacement'));
  queue.edit(draft(4, 'replacement'));
  first.resolve(detail(calls[0], 'old-created-id'));
  await saving;
  assert.equal(calls.length, 2);
  assert.equal(calls[1].id, 'replacement');
  assert.deepEqual(acks.map((ack) => ack.deck.id), ['replacement']);
});

test('unchanged persisted fields do not save again after ownership metadata refresh', async () => {
  const { queue, calls } = fixture();
  queue.reset(draft(2, 'existing'));
  queue.edit(structuredClone(draft(2, 'existing')));
  await queue.flush();
  assert.equal(calls.length, 0);
});

test('explicitly creating a named empty deck is saved even without card changes', async () => {
  const { queue, calls } = fixture();
  queue.reset(draft(0, null, 'New deck'));
  queue.edit(draft(0, null, 'New deck'), true);
  await queue.flush();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].cards, []);
});

test('a first-create retry keeps its creation token until the native ID is acknowledged', async () => {
  const { queue, calls, tokens } = fixture((value, count) => {
    if (count === 1) throw new Error('reply unavailable after commit');
    return detail(value, 'same-created-deck');
  });
  queue.edit(draft(1));
  await assert.rejects(queue.flush());
  queue.edit(draft(2));
  await queue.flush();
  assert.ok(tokens[0]);
  assert.equal(tokens[1], tokens[0]);
  assert.equal(calls[1].id, null);
  queue.edit(draft(3));
  await queue.flush();
  assert.equal(calls[2].id, 'same-created-deck');
  assert.equal(tokens[2], undefined);
  queue.reset({ id: null, name: '', cards: [] });
  queue.edit(draft(1));
  await queue.flush();
  assert.notEqual(tokens[3], tokens[0]);
});

test('canceling first unnamed creation resets its proposed cards without a native write', async () => {
  const { queue, calls } = fixture();
  queue.edit(draft(1, null, ''));
  queue.reset({ id: null, name: '', cards: [] });
  await queue.flush();
  assert.equal(calls.length, 0);
  assert.deepEqual(queue.getDraft().cards, []);
});

test('edited Add retries and target switches retain the original base after lost replies', () => {
  const bases = new CollectionAddBases();
  const original = { quantity: 0, cards: [] };
  const base = bases.capture('request', 'target-a', original);
  original.quantity = 99;
  assert.equal(base.quantity, 0);
  // First Add1 committed remotely, but its reply was lost. Choosing2 replaces
  // that logical addition; it must not use the now-persisted1 as a new base.
  assert.equal(bases.capture('request', 'target-a', { quantity: 1 }).quantity + 2, 2);
  bases.capture('request', 'target-b', { quantity: 8 });
  assert.equal(bases.get('request', 'target-b').quantity, 8);
  // Switching away/back after another lost reply must still allow the full4.
  assert.equal(bases.capture('request', 'target-a', { quantity: 2 }).quantity + 4, 4);
  assert.equal(bases.capture('request', 'target-a', { quantity: 4 }).quantity + 4, 4);
});

test('Add bases distinguish requests and preserve the empty new-target base', () => {
  const bases = new CollectionAddBases();
  assert.equal(bases.capture('one', 'new', null), null);
  assert.equal(bases.capture('one', 'new', { quantity: 1 }), null);
  bases.capture('one', 'existing', { quantity: 1 });
  assert.equal(bases.capture('two', 'existing', { quantity: 4 }).quantity, 4);
  bases.clear();
  assert.equal(bases.get('one', 'existing'), undefined);
});


const lifecycleSource = readFileSync(new URL('../src/lib/app-lifecycle.ts', import.meta.url), 'utf8');
const lifecycleOutput = ts.transpileModule(lifecycleSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
const { AppLifecycle, protectWindowClose } = await import(`data:text/javascript;base64,${Buffer.from(lifecycleOutput).toString('base64')}`);

function closeFixture(lifecycle, options = {}) {
  let handler;
  const calls = { destroy: 0, unlisten: 0 };
  const target = {
    onCloseRequested: async (next) => {
      handler = next;
      if (options.registration) await options.registration;
      return () => { calls.unlisten++; };
    },
    destroy: async () => { calls.destroy++; if (options.destroy) await options.destroy(); },
  };
  const guard = protectWindowClose(target, lifecycle);
  return {
    guard, calls,
    close() {
      const event = { prevented: false, preventDefault() { this.prevented = true; } };
      return { event, settled: handler(event) };
    },
  };
}

test('closing waits for the active deck task and the latest queued autosave before destroying', async () => {
  const initialWrite = deferred(), task = deferred(), ordering = [];
  const { queue, calls } = fixture(async (value, count) => {
    if (count === 1) await initialWrite.promise;
    ordering.push(`save:${value.cards[0].quantity}`);
    return detail(value, 'one-deck');
  });
  queue.edit(draft(1));
  const saving = queue.flush();
  queue.edit(draft(2));
  const lifecycle = new AppLifecycle();
  lifecycle.register(async () => { await task.promise; await queue.flush(); });
  const window = closeFixture(lifecycle, { destroy: async () => { ordering.push('destroy'); } });
  await window.guard.ready;
  const closing = window.close();
  assert.equal(closing.event.prevented, true);
  assert.equal(lifecycle.isLocked(), true);
  initialWrite.resolve();
  await saving;
  await tick();
  assert.equal(window.calls.destroy, 0);
  task.resolve();
  await closing.settled;
  assert.equal(calls.length, 2);
  assert.deepEqual(ordering, ['save:1', 'save:2', 'destroy']);
  assert.equal(window.calls.destroy, 1);
  assert.equal(lifecycle.isLocked(), false);
  window.guard.dispose();
});

test('failed autosave keeps the window open with a persistent error and retries the same exit', async () => {
  let fail = true;
  const { queue } = fixture(async value => { if (fail) throw Error('Forge folder unavailable'); return detail(value); });
  queue.edit(draft());
  const lifecycle = new AppLifecycle();
  lifecycle.register(() => queue.flush());
  const window = closeFixture(lifecycle);
  await window.guard.ready;
  const closing = window.close();
  await closing.settled;
  assert.equal(window.calls.destroy, 0);
  assert.equal(lifecycle.isLocked(), false);
  assert.equal(lifecycle.canExit(), false);
  assert.match(lifecycle.getSnapshot().error, /Forge folder unavailable/);
  fail = false;
  await lifecycle.retry();
  assert.equal(window.calls.destroy, 1);
  assert.equal(lifecycle.getSnapshot().error, null);
  window.guard.dispose();
});

test('an unnamed pending deck blocks exit until named or its proposed edits are cancelled', async () => {
  const { queue, calls } = fixture();
  queue.edit(draft(1, null, ''));
  const lifecycle = new AppLifecycle();
  lifecycle.register(() => queue.flush());
  let exits = 0;
  await assert.rejects(lifecycle.run('close', async () => { exits++; }), /Name this deck/);
  assert.equal(exits, 0);
  assert.equal(calls.length, 0);
  queue.reset({ id: null, name: '', cards: [] });
  await lifecycle.retry();
  assert.equal(exits, 1);
});

test('repeated close, install, and restart intents share one locked operation', async () => {
  const preparation = deferred(), actions = [];
  const lifecycle = new AppLifecycle();
  lifecycle.register(() => preparation.promise);
  const first = lifecycle.run('close', async () => {
    assert.equal(lifecycle.isLocked(), true);
    assert.equal(lifecycle.canExit(), true);
    actions.push('close');
  });
  assert.equal(lifecycle.canExit(), false);
  const install = lifecycle.run('install-update', async () => { actions.push('install'); });
  const restart = lifecycle.run('restart', async () => { actions.push('restart'); });
  assert.equal(first, install);
  assert.equal(first, restart);
  preparation.resolve();
  await first;
  assert.deepEqual(actions, ['close']);
  assert.equal(lifecycle.canExit(), false);
});

test('both update installation and Linux restart await preparation and stay locked through the native action', async () => {
  for (const intent of ['install-update', 'restart']) {
    const preparation = deferred(), native = deferred();
    const lifecycle = new AppLifecycle();
    let invoked = false;
    lifecycle.register(() => preparation.promise);
    const operation = lifecycle.run(intent, async () => { invoked = true; await native.promise; });
    await tick();
    assert.equal(invoked, false);
    preparation.resolve();
    await tick();
    assert.equal(invoked, true);
    assert.equal(lifecycle.isLocked(), true);
    assert.equal(lifecycle.canExit(), true);
    native.resolve();
    await operation;
    assert.equal(lifecycle.isLocked(), false);
  }
});

test('an installer-requested native close is allowed only after deck preparation succeeds', async () => {
  const lifecycle = new AppLifecycle();
  const window = closeFixture(lifecycle);
  await window.guard.ready;
  let installerEvent;
  await lifecycle.run('install-update', async () => {
    const nativeClose = window.close();
    installerEvent = nativeClose.event;
    await nativeClose.settled;
  });
  assert.equal(installerEvent.prevented, false);
  assert.equal(window.calls.destroy, 0); // The SDK performs its default destroy after the allowed handler.
  window.guard.dispose();
});

test('soft deck-task failure settles without deadlocking and blocks the exit action', async () => {
  const task = deferred();
  let taskFailure = null, invoked = false;
  const lifecycle = new AppLifecycle();
  lifecycle.register(async () => { await task.promise; if (taskFailure) throw Error(taskFailure); });
  const exiting = lifecycle.run('restart', async () => { invoked = true; });
  taskFailure = 'Collection Add did not save';
  task.resolve();
  await assert.rejects(exiting, /Collection Add/);
  assert.equal(lifecycle.isLocked(), false);
  assert.equal(invoked, false);
  taskFailure = null; // User explicitly cancelled or corrected the failed modal action.
  await lifecycle.retry();
  assert.equal(invoked, true);
});

test('late native close-listener registration is cleaned up after disposal', async () => {
  const registration = deferred();
  const lifecycle = new AppLifecycle();
  const window = closeFixture(lifecycle, { registration: registration.promise });
  window.guard.dispose();
  registration.resolve();
  await window.guard.ready;
  assert.equal(window.calls.unlisten, 1);
  const late = window.close();
  assert.equal(late.event.prevented, true);
  await late.settled;
  assert.equal(window.calls.destroy, 0);
});

test('native registration and destroy failures stay observable and never force a second close', async () => {
  const lifecycle = new AppLifecycle();
  const guard = protectWindowClose({ onCloseRequested: async () => { throw Error('listener denied'); }, destroy: async () => {} }, lifecycle);
  await assert.rejects(guard.ready, /listener denied/);
  guard.dispose();
  const window = closeFixture(lifecycle, { destroy: async () => { throw Error('destroy denied'); } });
  await window.guard.ready;
  await window.close().settled;
  assert.equal(window.calls.destroy, 1);
  assert.equal(lifecycle.isLocked(), false);
  assert.match(lifecycle.getSnapshot().error, /destroy denied/);
  window.guard.dispose();
});


test('a second ordinary close after flushing cannot issue another destroy while the first is pending', async () => {
  const nativeDestroy = deferred();
  const lifecycle = new AppLifecycle();
  const window = closeFixture(lifecycle, { destroy: () => nativeDestroy.promise });
  await window.guard.ready;
  const first = window.close();
  await tick();
  assert.equal(window.calls.destroy, 1);
  const second = window.close();
  assert.equal(second.event.prevented, true);
  await second.settled;
  assert.equal(window.calls.destroy, 1);
  nativeDestroy.resolve();
  await first.settled;
  window.guard.dispose();
});
