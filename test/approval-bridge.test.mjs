/**
 * ApprovalBridge unit tests: claim/delegate/timeout/abort/dispose semantics.
 * No DSH Host required — uses a fake ctx that mimics cordis waterfall dispatch.
 */
import assert from 'node:assert/strict';
import { ApprovalBridge } from '../src/server/approval-bridge.mjs';

const results = { passed: 0, failed: 0 };
async function test(name, fn) {
  try {
    await fn();
    results.passed += 1;
    console.log('PASS  ' + name);
  } catch (error) {
    results.failed += 1;
    console.error('FAIL  ' + name + '\n      ' + (error && error.stack ? error.stack.split('\n').slice(0, 5).join('\n      ') : error));
  }
}

/** Fake cordis ctx that records listeners and can dispatch the waterfall. */
function createCtx() {
  const listeners = [];
  return {
    on(event, handler, options) {
      listeners.push({ event, handler, global: options && options.global === true });
    },
    off(event, handler) {
      const i = listeners.findIndex((l) => l.event === event && l.handler === handler);
      if (i >= 0) listeners.splice(i, 1);
    },
    listeners,
    /** Simulate cordis waterfall: first listener that resolves non-undefined claims. */
    async dispatch(event, request) {
      let i = 0;
      const next = async () => {
        const list = listeners.filter((l) => l.event === event);
        const entry = list[i++];
        if (!entry) return 'host-inner';
        return entry.handler(request, next);
      };
      return next();
    },
  };
}

function makeRequest(overrides = {}) {
  return {
    agent: { session: { id: 'sess-1' } },
    toolName: 'pwsh',
    callId: 'call-1',
    reason: 'run a command',
    displayReason: { en: 'Run a command', zh: '执行命令' },
    ...overrides,
  };
}

async function main() {
  await test('registers a global approval/request listener', async () => {
    const ctx = createCtx();
    const bridge = new ApprovalBridge({ ctx, hasWatcher: () => true });
    assert.equal(bridge.install(), true);
    assert.equal(ctx.listeners.length, 1);
    assert.equal(ctx.listeners[0].event, 'approval/request');
    assert.equal(ctx.listeners[0].global, true);
    bridge.dispose();
  });

  await test('delegates when no phone watches the session', async () => {
    const ctx = createCtx();
    const bridge = new ApprovalBridge({ ctx, hasWatcher: () => false });
    bridge.install();
    const outcome = await ctx.dispatch('approval/request', makeRequest());
    assert.equal(outcome, 'host-inner', 'must call next()');
    assert.equal(bridge.stats.forwarded, 0);
    assert.equal(bridge.stats.delegated, 1);
    bridge.dispose();
  });

  await test('forwards to phone and claims on allow', async () => {
    const ctx = createCtx();
    const frames = [];
    const bridge = new ApprovalBridge({ ctx, hasWatcher: () => true, emit: (f) => frames.push(f), timeoutMs: 5000 });
    bridge.install();
    const promise = ctx.dispatch('approval/request', makeRequest());
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(frames.length, 1);
    assert.equal(frames[0].type, 'approval-request');
    assert.equal(frames[0].data.sessionId, 'sess-1');
    assert.equal(frames[0].data.toolName, 'pwsh');
    assert.equal(frames[0].data.reason, '执行命令', 'prefers zh displayReason');
    assert.equal(bridge.answer(frames[0].data.requestId, 'allow'), true);
    assert.equal(await promise, 'allowed-once');
    assert.equal(bridge.stats.answered, 1);
    bridge.dispose();
  });

  await test('reject maps to rejected', async () => {
    const ctx = createCtx();
    let requestId = null;
    const bridge = new ApprovalBridge({ ctx, hasWatcher: () => true, emit: (f) => { requestId = f.data.requestId; }, timeoutMs: 5000 });
    bridge.install();
    const promise = ctx.dispatch('approval/request', makeRequest());
    await new Promise((r) => setTimeout(r, 20));
    bridge.answer(requestId, 'reject');
    assert.equal(await promise, 'rejected');
    bridge.dispose();
  });

  await test('times out and delegates instead of hanging the session', async () => {
    const ctx = createCtx();
    const frames = [];
    const bridge = new ApprovalBridge({ ctx, hasWatcher: () => true, emit: (f) => frames.push(f), timeoutMs: 60 });
    bridge.install();
    const started = Date.now();
    const outcome = await ctx.dispatch('approval/request', makeRequest());
    const elapsed = Date.now() - started;
    assert.equal(outcome, 'host-inner', 'timeout must delegate');
    assert.ok(elapsed >= 55 && elapsed < 1500, 'timeout should be ~60ms, got ' + elapsed);
    assert.equal(bridge.stats.timedOut, 1);
    assert.ok(frames.some((f) => f.type === 'approval-closed' && f.data.reason === 'timeout'));
    assert.equal(bridge.pending.size, 0, 'no leaked pending record');
    bridge.dispose();
  });

  await test('caller abort delegates and cleans up', async () => {
    const ctx = createCtx();
    const controller = new AbortController();
    const bridge = new ApprovalBridge({ ctx, hasWatcher: () => true, emit: () => {}, timeoutMs: 10000 });
    bridge.install();
    const promise = ctx.dispatch('approval/request', makeRequest({ signal: controller.signal }));
    await new Promise((r) => setTimeout(r, 20));
    controller.abort();
    assert.equal(await promise, 'host-inner');
    assert.equal(bridge.pending.size, 0);
    bridge.dispose();
  });

  await test('already-aborted signal delegates immediately', async () => {
    const ctx = createCtx();
    const controller = new AbortController();
    controller.abort();
    const bridge = new ApprovalBridge({ ctx, hasWatcher: () => true, emit: () => {}, timeoutMs: 10000 });
    bridge.install();
    const outcome = await ctx.dispatch('approval/request', makeRequest({ signal: controller.signal }));
    assert.equal(outcome, 'host-inner');
    bridge.dispose();
  });

  await test('double answer is refused (idempotent, no crash)', async () => {
    const ctx = createCtx();
    let requestId = null;
    const bridge = new ApprovalBridge({ ctx, hasWatcher: () => true, emit: (f) => { requestId = f.data.requestId; }, timeoutMs: 5000 });
    bridge.install();
    const promise = ctx.dispatch('approval/request', makeRequest());
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(bridge.answer(requestId, 'allow'), true);
    assert.equal(bridge.answer(requestId, 'reject'), false, 'second answer refused');
    assert.equal(await promise, 'allowed-once', 'first answer wins');
    bridge.dispose();
  });

  await test('unknown requestId answer returns false', async () => {
    const ctx = createCtx();
    const bridge = new ApprovalBridge({ ctx, hasWatcher: () => true });
    bridge.install();
    assert.equal(bridge.answer('nope', 'allow'), false);
    assert.equal(bridge.answer('nope', 'bogus'), false);
    bridge.dispose();
  });

  await test('disabled bridge delegates everything', async () => {
    const ctx = createCtx();
    const bridge = new ApprovalBridge({ ctx, hasWatcher: () => true, isEnabled: () => false });
    assert.equal(bridge.install(), false);
    assert.equal(ctx.listeners.length, 0);
    assert.equal(bridge.answer('x', 'allow'), false);
    bridge.dispose();
  });

  await test('dispose settles in-flight requests and unregisters', async () => {
    const ctx = createCtx();
    const bridge = new ApprovalBridge({ ctx, hasWatcher: () => true, emit: () => {}, timeoutMs: 10000 });
    bridge.install();
    const promise = ctx.dispatch('approval/request', makeRequest());
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(bridge.pending.size, 1);
    bridge.dispose();
    assert.equal(await promise, 'host-inner', 'dispose must not leave the waterfall hanging');
    assert.equal(bridge.pending.size, 0);
    assert.equal(ctx.listeners.length, 0);
  });

  await test('missing agent or toolName delegates', async () => {
    const ctx = createCtx();
    const bridge = new ApprovalBridge({ ctx, hasWatcher: () => true });
    bridge.install();
    assert.equal(await ctx.dispatch('approval/request', { toolName: 'x' }), 'host-inner');
    assert.equal(await ctx.dispatch('approval/request', { agent: { session: { id: 's' } } }), 'host-inner');
    bridge.dispose();
  });

  await test('pendingFor exposes only that session', async () => {
    const ctx = createCtx();
    const bridge = new ApprovalBridge({ ctx, hasWatcher: () => true, emit: () => {}, timeoutMs: 5000 });
    bridge.install();
    const p1 = ctx.dispatch('approval/request', makeRequest());
    const p2 = ctx.dispatch('approval/request', makeRequest({ agent: { session: { id: 'sess-2' } } }));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(bridge.pendingFor('sess-1').length, 1);
    assert.equal(bridge.pendingFor('sess-2').length, 1);
    assert.equal(bridge.pendingFor('sess-3').length, 0);
    for (const item of bridge.pendingFor('sess-1')) bridge.answer(item.requestId, 'allow');
    for (const item of bridge.pendingFor('sess-2')) bridge.answer(item.requestId, 'reject');
    await Promise.all([p1, p2]);
    bridge.dispose();
  });

  console.log('');
  console.log('ApprovalBridge Passed: ' + results.passed + '  Failed: ' + results.failed);
  if (results.failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
