/**
 * QuestionsBridge unit tests: batching, completeness, timeout, abort, dispose.
 * Uses a fake ctx that mimics cordis waterfall dispatch.
 */
import assert from 'node:assert/strict';
import { QuestionsBridge } from '../src/server/questions-bridge.mjs';

const results = { passed: 0, failed: 0 };
async function test(name, fn) {
  try { await fn(); results.passed += 1; console.log('PASS  ' + name); }
  catch (e) { results.failed += 1; console.error('FAIL  ' + name + '\n      ' + (e.stack || e).toString().split('\n').slice(0, 4).join('\n      ')); }
}

function createCtx() {
  const listeners = [];
  return {
    on(event, handler, options) { listeners.push({ event, handler, global: !!(options && options.global), prepend: !!(options && options.prepend) }); },
    off(event, handler) { const i = listeners.findIndex((l) => l.event === event && l.handler === handler); if (i >= 0) listeners.splice(i, 1); },
    listeners,
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

const makeRequest = (overrides = {}) => ({
  agent: { session: { id: 'sess-1' } },
  questions: [
    { id: 'q1', question: '选哪个方案？', header: '方案', options: [{ label: 'A' }, { label: 'B', description: '更稳' }] },
    { id: 'q2', question: '是否继续？', options: [{ label: '是' }, { label: '否' }] },
  ],
  ...overrides,
});

async function main() {
  await test('registers a global prepended listener', async () => {
    const ctx = createCtx();
    const b = new QuestionsBridge({ ctx, hasWatcher: () => true });
    assert.equal(b.install(), true);
    assert.equal(ctx.listeners.length, 1);
    assert.equal(ctx.listeners[0].event, 'user-questions/request');
    assert.equal(ctx.listeners[0].global, true);
    assert.equal(ctx.listeners[0].prepend, true, 'must prepend to beat the gateway forwarder');
    b.dispose();
  });

  await test('delegates without a phone watching', async () => {
    const ctx = createCtx();
    const b = new QuestionsBridge({ ctx, hasWatcher: () => false });
    b.install();
    assert.equal(await ctx.dispatch('user-questions/request', makeRequest()), 'host-inner');
    assert.equal(b.stats.delegated, 1);
    b.dispose();
  });

  await test('delegates without agent/session', async () => {
    const ctx = createCtx();
    const b = new QuestionsBridge({ ctx, hasWatcher: () => true });
    b.install();
    assert.equal(await ctx.dispatch('user-questions/request', makeRequest({ agent: undefined })), 'host-inner');
    b.dispose();
  });

  await test('forwards serialized questions and claims a complete answer', async () => {
    const ctx = createCtx();
    const frames = [];
    const b = new QuestionsBridge({ ctx, hasWatcher: () => true, emit: (f) => frames.push(f), timeoutMs: 5000 });
    b.install();
    const promise = ctx.dispatch('user-questions/request', makeRequest());
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(frames[0].type, 'question-request');
    const data = frames[0].data;
    assert.equal(data.questions.length, 2);
    assert.equal(data.questions[0].options.length, 2);
    assert.equal(data.questions[0].options[1].description, '更稳');
    const ok = b.answer(data.requestId, [
      { id: 'q1', selected: ['A'] },
      { id: 'q2', selected: ['是'] },
    ]);
    assert.equal(ok, true);
    const outcome = await promise;
    assert.deepEqual(outcome, { answers: [{ id: 'q1', selected: ['A'] }, { id: 'q2', selected: ['是'] }] });
    assert.equal(b.stats.answered, 1);
    b.dispose();
  });

  await test('partial answer is rejected and does not claim', async () => {
    const ctx = createCtx();
    let requestId = null;
    const b = new QuestionsBridge({ ctx, hasWatcher: () => true, emit: (f) => { requestId = f.data.requestId; }, timeoutMs: 60 });
    b.install();
    const promise = ctx.dispatch('user-questions/request', makeRequest());
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(b.answer(requestId, [{ id: 'q1', selected: ['A'] }]), false, 'missing q2 must be refused');
    const outcome = await promise;
    assert.equal(outcome, 'host-inner', 'incomplete answer must fall through');
    assert.equal(b.pending.size, 0);
    b.dispose();
  });

  await test('empty selection without custom is rejected', async () => {
    const ctx = createCtx();
    let requestId = null;
    const b = new QuestionsBridge({ ctx, hasWatcher: () => true, emit: (f) => { requestId = f.data.requestId; }, timeoutMs: 60 });
    b.install();
    const promise = ctx.dispatch('user-questions/request', makeRequest());
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(b.answer(requestId, [{ id: 'q1', selected: [] }, { id: 'q2', selected: ['是'] }]), false);
    await promise;
    b.dispose();
  });

  await test('custom free-text answer is accepted', async () => {
    const ctx = createCtx();
    let requestId = null;
    const b = new QuestionsBridge({ ctx, hasWatcher: () => true, emit: (f) => { requestId = f.data.requestId; }, timeoutMs: 5000 });
    b.install();
    const promise = ctx.dispatch('user-questions/request', makeRequest());
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(b.answer(requestId, [{ id: 'q1', selected: [], custom: '用方案 C' }, { id: 'q2', selected: ['是'] }]), true);
    const outcome = await promise;
    assert.equal(outcome.answers[0].custom, '用方案 C');
    b.dispose();
  });

  await test('timeout delegates and notifies', async () => {
    const ctx = createCtx();
    const frames = [];
    const b = new QuestionsBridge({ ctx, hasWatcher: () => true, emit: (f) => frames.push(f), timeoutMs: 60 });
    b.install();
    const started = Date.now();
    const outcome = await ctx.dispatch('user-questions/request', makeRequest());
    assert.equal(outcome, 'host-inner');
    assert.ok(Date.now() - started >= 55);
    assert.equal(b.stats.timedOut, 1);
    assert.ok(frames.some((f) => f.type === 'question-closed' && f.data.reason === 'timeout'));
    assert.equal(b.pending.size, 0);
    b.dispose();
  });

  await test('abort delegates', async () => {
    const ctx = createCtx();
    const controller = new AbortController();
    const b = new QuestionsBridge({ ctx, hasWatcher: () => true, emit: () => {}, timeoutMs: 10000 });
    b.install();
    const promise = ctx.dispatch('user-questions/request', makeRequest({ signal: controller.signal }));
    await new Promise((r) => setTimeout(r, 20));
    controller.abort();
    assert.equal(await promise, 'host-inner');
    assert.equal(b.pending.size, 0);
    b.dispose();
  });

  await test('double answer refused', async () => {
    const ctx = createCtx();
    let requestId = null;
    const b = new QuestionsBridge({ ctx, hasWatcher: () => true, emit: (f) => { requestId = f.data.requestId; }, timeoutMs: 5000 });
    b.install();
    const promise = ctx.dispatch('user-questions/request', makeRequest());
    await new Promise((r) => setTimeout(r, 20));
    const ans = [{ id: 'q1', selected: ['A'] }, { id: 'q2', selected: ['是'] }];
    assert.equal(b.answer(requestId, ans), true);
    assert.equal(b.answer(requestId, ans), false);
    await promise;
    b.dispose();
  });

  await test('dispose settles in-flight and unregisters', async () => {
    const ctx = createCtx();
    const b = new QuestionsBridge({ ctx, hasWatcher: () => true, emit: () => {}, timeoutMs: 10000 });
    b.install();
    const promise = ctx.dispatch('user-questions/request', makeRequest());
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(b.pending.size, 1);
    b.dispose();
    assert.equal(await promise, 'host-inner');
    assert.equal(b.pending.size, 0);
    assert.equal(ctx.listeners.length, 0);
  });

  await test('pendingFor filters by session', async () => {
    const ctx = createCtx();
    const b = new QuestionsBridge({ ctx, hasWatcher: () => true, emit: () => {}, timeoutMs: 5000 });
    b.install();
    const p1 = ctx.dispatch('user-questions/request', makeRequest());
    const p2 = ctx.dispatch('user-questions/request', makeRequest({ agent: { session: { id: 'sess-2' } } }));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(b.pendingFor('sess-1').length, 1);
    assert.equal(b.pendingFor('sess-2').length, 1);
    assert.equal(b.pendingFor('sess-3').length, 0);
    for (const item of b.pendingFor('sess-1')) b.answer(item.requestId, [{ id: 'q1', selected: ['A'] }, { id: 'q2', selected: ['是'] }]);
    for (const item of b.pendingFor('sess-2')) b.answer(item.requestId, [{ id: 'q1', selected: ['A'] }, { id: 'q2', selected: ['是'] }]);
    await Promise.all([p1, p2]);
    b.dispose();
  });

  console.log('');
  console.log('QuestionsBridge Passed: ' + results.passed + '  Failed: ' + results.failed);
  if (results.failed > 0) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
