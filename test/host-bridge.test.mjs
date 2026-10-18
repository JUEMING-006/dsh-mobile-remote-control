/**
 * HostBridge unit tests against a fake Host context whose service shapes mirror
 * the real dsh services (sessionController / workspaceRegistry /
 * workspaceChanges / global event bus). No DSH Host is required.
 */
import assert from 'node:assert/strict';
import { HostBridge } from '../src/server/host-bridge.mjs';

const NOW = Date.now();

function summary(id, options = {}) {
  const projections = { values: {} };
  if (options.title) projections.values.title = options.title;
  if (options.turns || options.steps) projections.values.sessionStats = { turns: options.turns || 0, steps: options.steps || 0 };
  if (options.model) projections.values.modelSelection = { lastUsed: null, next: options.model };
  return {
    sessionId: id,
    updatedAt: options.updatedAt || NOW,
    running: options.running === true,
    blank: options.blank === true,
    agentAvailable: options.agentAvailable !== false,
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.origin ? { origin: options.origin } : {}),
    projections,
  };
}

const EVENTS = [
  { type: 'user/message', seq: 0, time: NOW - 50000, surfaceOp: 'append', data: { id: 'u1', content: [{ type: 'text', text: '你好' }], source: { kind: 'user' } } },
  {
    type: 'assistant/message', seq: 1, time: NOW - 49000, surfaceOp: 'append',
    data: {
      turn: 1, step: 1,
      message: {
        id: 'a1', source: { kind: 'model', provider: 'deepseek-account', model: 'deepseek-flash' },
        content: [
          { type: 'reasoning', text: '先看文件' },
          { type: 'tool-call', id: 'call-1', name: 'read', arguments: '{"file_path":"a.mjs"}' },
          { type: 'text', text: '读完了' },
        ],
      },
      usage: { inputTokens: 11, outputTokens: 7 },
    },
  },
  { type: 'tool/result', seq: 2, time: NOW - 48000, surfaceOp: 'append', data: { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'call-1', source: { kind: 'tool', callId: 'call-1' }, content: [{ type: 'text', text: 'file content' }], isError: false } } },
  { type: 'workspace/changes', seq: 3, time: NOW - 47000, data: { turn: 1 } },
  { type: 'turn/end', seq: 4, time: NOW - 46000, data: { turn: 1, reason: { kind: 'completed' } } },
  { type: 'turn/start', seq: 0, time: NOW - 52000, data: { turn: 1 } },
];

function createFakeCtx(options = {}) {
  const listeners = [];
  const calls = { prompt: [], cancel: [], selectModel: [], create: [], search: [], page: [], follow: [] };
  const controller = options.controller || {
    async list() {
      return {
        items: [
          summary('s1', { title: '真实标题', cwd: 'D:/proj/alpha', turns: 3, steps: 12, model: { provider: 'deepseek-account', model: 'deepseek-flash' } }),
          summary('s2', { title: '归档会话', cwd: 'D:/proj/alpha', updatedAt: NOW - 86400000 * 2 }),
          summary('s3', { title: '子代理', origin: 'subagent', cwd: 'D:/proj/alpha' }),
          summary('s4', { blank: true, cwd: 'D:/other/beta', updatedAt: NOW - 86400000 * 40 }),
        ],
      };
    },
    async projections(request, signal) {
      assert.ok(signal && typeof signal.throwIfAborted === 'function', 'projections requires an AbortSignal');
      return { kind: 'sequenced', asOfSeq: 4, values: {} };
    },
    async inspect() {
      return { meta: {}, inheritedEventCount: 0, events: EVENTS };
    },
    async page(request, signal) {
      calls.page.push(request);
      assert.ok(signal && typeof signal.throwIfAborted === 'function', 'page requires an AbortSignal');
      return { records: EVENTS.map((event) => ({ type: 'event', event })), hasMore: request.beforeSeq === undefined ? false : true };
    },
    async prompt(request, signal) {
      calls.prompt.push(request);
      assert.ok(signal && typeof signal.throwIfAborted === 'function', 'prompt requires an AbortSignal');
      return { accepted: true };
    },
    async cancel(request) {
      calls.cancel.push(request);
      return { accepted: true };
    },
    async selectModel(request) {
      calls.selectModel.push(request);
      return { selected: { provider: request.provider, model: request.model } };
    },
    async modelCatalog() {
      return {
        groups: [{ id: 'deepseek-account', name: 'DeepSeek', models: [{ id: 'deepseek-flash', name: 'deepseek-flash' }] }],
        default: { provider: 'deepseek-account', model: 'deepseek-flash' },
        failures: [],
        routableProviders: ['deepseek-account'],
      };
    },
    async create(request) {
      calls.create.push(request);
      return { sessionId: 'created-1' };
    },
    async search(request) {
      calls.search.push(request);
      return { items: [{ sessionId: 's1', snippet: '你好' }], hasMore: false };
    },
    async rename(request) {
      return { title: request.title, seq: 10 };
    },
    follow(request, signal) {
      calls.follow.push(request);
      assert.ok(signal && typeof signal.throwIfAborted === 'function', 'follow requires an AbortSignal');
      const frames = [
        { type: 'snapshot', header: { id: request.address.sessionId, createdAt: NOW, cwd: 'D:/proj/alpha' }, cursor: 4, records: EVENTS.map((event) => ({ type: 'event', event })), hasMore: false, projections: { asOfSeq: 4, values: { title: '真实标题', sessionStats: { turns: 3, steps: 12 } } } },
        { type: 'event', event: { type: 'user/message', seq: 5, time: NOW, surfaceOp: 'append', data: { id: 'u2', content: [{ type: 'text', text: '继续' }], source: { kind: 'user' } } } },
        { type: 'event', event: { type: 'workspace/changes', seq: 6, time: NOW, data: { turn: 2 } } },
        { type: 'assistant-stream', frame: { type: 'start', attemptId: 'a', revision: 1, turn: 2, step: 1 } },
        { type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'a', revision: 1, index: 0, time: NOW, chunk: { type: 'text-delta', index: 0, text: '流式' } } },
        { type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'a', revision: 1, index: 1, time: NOW, chunk: { type: 'reasoning-delta', index: 1, text: '思考' } } },
      ];
      return (async function* generate() {
        for (const frame of frames) {
          if (signal.aborted) return;
          yield frame;
        }
      })();
    },
  };
  const workspaces = [
    { id: 'ws-alpha', title: 'alpha', path: 'D:/proj/alpha', sessionIds: ['s1', 's2', 's3'] },
    { id: 'ws-beta', title: 'beta', path: 'D:/other/beta', sessionIds: [] },
  ];
  const ctx = {
    sessionController: controller,
    workspaceRegistry: {
      list: () => workspaces,
      archivedSessionIds: ['s2'],
    },
    get(name) {
      if (name === 'workspaceChanges') {
        return {
          summary(sessionId, seq) {
            if (seq !== 3 && seq !== 6) return null;
            return { turn: seq === 3 ? 1 : 2, cwd: 'D:/proj/alpha', total: 1, added: 5, deleted: 2, files: [{ path: 'a.mjs', display: 'a.mjs', added: 5, deleted: 2 }] };
          },
          async diff() {
            return { kind: 'text', path: 'a.mjs', display: 'a.mjs', before: true, after: true, coarse: false, hunks: [] };
          },
        };
      }
      return undefined;
    },
    on(event, handler, opts) {
      listeners.push({ event, handler, opts });
    },
    off(event, handler) {
      const index = listeners.findIndex((listener) => listener.event === event && listener.handler === handler);
      if (index >= 0) listeners.splice(index, 1);
    },
  };
  return { ctx, calls, listeners, workspaces };
}

const results = { passed: 0, failed: 0 };

async function test(name, fn) {
  try {
    await fn();
    results.passed += 1;
    console.log('PASS  ' + name);
  } catch (error) {
    results.failed += 1;
    console.error('FAIL  ' + name);
    console.error('      ' + (error && error.stack ? error.stack.split('\n').slice(0, 5).join('\n      ') : error));
  }
}

async function main() {
  await test('bootstrap filters archived/subagent and maps real projections', async () => {
    const { ctx } = createFakeCtx();
    const bridge = new HostBridge(ctx);
    const bootstrap = await bridge.getBootstrap();
    assert.equal(bootstrap.counts.workspaces, 2);
    assert.equal(bootstrap.sessions.length, 2);
    const s1 = bootstrap.sessions.find((session) => session.id === 's1');
    assert.equal(s1.title, '真实标题');
    assert.equal(s1.workspaceTitle, 'alpha');
    assert.equal(s1.turns, 3);
    assert.equal(s1.model.model, 'deepseek-flash');
    const blank = bootstrap.sessions.find((session) => session.id === 's4');
    assert.equal(blank.blank, true);
    assert.equal(blank.workspaceTitle, 'beta');
    assert.equal(bootstrap.defaultModel.model, 'deepseek-flash');
    assert.equal(bootstrap.server.protocol, 1);
    bridge.dispose();
  });

  await test('getMessages normalizes events, patches tool result and keeps changes', async () => {
    const { ctx } = createFakeCtx();
    const bridge = new HostBridge(ctx);
    const page = await bridge.getMessages('s1', { maxMessages: 50 });
    assert.equal(page.messages.length, 2);
    const assistant = page.messages[1];
    assert.equal(assistant.blocks[0].type, 'reasoning');
    const tool = assistant.blocks.find((block) => block.type === 'tool');
    assert.equal(tool.status, 'done');
    assert.equal(tool.output, 'file content');
    assert.equal(page.hasMore, false);
    assert.equal(page.oldestSeq, 0);
    assert.equal(page.changes.length, 1);
    assert.equal(page.changes[0].summary.added, 5);
    assert.equal(page.turns.length, 1);
    assert.equal(page.turns[0].turn, 1);
    assert.equal(page.turns[0].startedAt, NOW - 52000);
    assert.equal(page.turns[0].endedAt, NOW - 46000);
    assert.equal(page.turns[0].reasonKind, 'completed');
    bridge.dispose();
  });

  await test('getSessionDetail combines summary and messages', async () => {
    const { ctx } = createFakeCtx();
    const bridge = new HostBridge(ctx);
    const detail = await bridge.getSessionDetail('s1');
    assert.equal(detail.summary.id, 's1');
    assert.equal(detail.messages.length, 2);
    assert.equal(detail.turns.length, 1);
    assert.equal(detail.oldestSeq, 0);
    bridge.dispose();
  });

  await test('followSession yields opened + message + changes + stream frames', async () => {
    const { ctx } = createFakeCtx();
    const bridge = new HostBridge(ctx);
    const controller = new AbortController();
    const frames = [];
    for await (const frame of bridge.followSession('s1', controller.signal)) {
      frames.push(frame);
      if (frames.length >= 7) break;
    }
    const opened = frames.find((frame) => frame.type === 'opened');
    assert.ok(opened);
    assert.equal(opened.data.messages.length, 2);
    assert.equal(opened.data.changes.length, 1);
    assert.equal(opened.data.turns.length, 1);
    assert.equal(opened.data.turns[0].turn, 1);
    assert.equal(opened.data.summary.title, '真实标题');
    assert.ok(frames.some((frame) => frame.type === 'event' && frame.event.kind === 'message'));
    assert.ok(frames.some((frame) => frame.type === 'event' && frame.event.kind === 'changes'));
    assert.ok(frames.some((frame) => frame.type === 'event' && frame.event.kind === 'stream-start'));
    assert.ok(frames.some((frame) => frame.type === 'event' && frame.event.kind === 'stream' && frame.event.block === 'text'));
    assert.ok(frames.some((frame) => frame.type === 'event' && frame.event.kind === 'stream' && frame.event.block === 'reasoning'));
    bridge.dispose();
  });

  await test('commands forward the exact request shapes', async () => {
    const { ctx, calls } = createFakeCtx();
    const bridge = new HostBridge(ctx);
    await bridge.prompt('s1', '  继续优化  ', 'req-1');
    assert.equal(calls.prompt[0].sessionId, 's1');
    assert.equal(calls.prompt[0].requestId, 'req-1');
    assert.deepEqual(calls.prompt[0].content, [{ type: 'text', text: '继续优化' }]);
    assert.equal(calls.prompt[0].mode, undefined);

    await bridge.cancel('s1');
    assert.deepEqual(calls.cancel[0], { sessionId: 's1' });

    const model = await bridge.selectModel('s1', 'min', 'MiniMax-M3', 'high');
    assert.deepEqual(calls.selectModel[0], { sessionId: 's1', provider: 'min', model: 'MiniMax-M3', reasoningEffort: 'high' });
    assert.equal(model.selection.model, 'MiniMax-M3');

    const created = await bridge.createSession({ workspaceId: 'ws-alpha' });
    assert.equal(created.sessionId, 'created-1');
    assert.equal(calls.create[0].workspaceId, 'ws-alpha');

    const search = await bridge.search('你好');
    assert.equal(calls.search[0].query, '你好');
    assert.equal(search.items[0].title, '真实标题');
    bridge.dispose();
  });

  await test('global session events update running state and re-emit', async () => {
    const { ctx, listeners } = createFakeCtx();
    const bridge = new HostBridge(ctx);
    const statuses = [];
    bridge.on('status', (payload) => statuses.push(payload));
    const statusListener = listeners.find((listener) => listener.event === 'api-session/status');
    assert.ok(statusListener, 'bridge subscribes to api-session/status');
    assert.equal(statusListener.opts.global, true);
    statusListener.handler('s1', true);
    assert.equal(bridge.isRunning('s1'), true);
    assert.deepEqual(statuses[0], { sessionId: 's1', running: true });
    const streamListener = listeners.find((listener) => listener.event === 'agent/assistant-stream');
    assert.ok(streamListener);
    bridge.dispose();
    assert.equal(listeners.length, 0, 'dispose removes every ctx listener');
  });

  await test('getUsage never throws when project services are absent', async () => {
    const { ctx } = createFakeCtx();
    // Simulate a profile without the projection rows: ctx.get returns undefined for them.
    const bridge = new HostBridge(ctx);
    const usage = bridge.getUsage('s1');
    assert.equal(usage, null, 'absent projections must yield null, not an exception');
    const detail = await bridge.getSessionDetail('s1');
    assert.equal(detail.usage, null);
    bridge.dispose();
  });

  await test('getUsage reads tokenUsage and contextPressure when available', async () => {
    const { ctx } = createFakeCtx();
    const fakeSession = { id: 's1' };
    ctx.get = (name) => {
      if (name === 'sessionProjections') {
        return {
          snapshot: () => ({
            values: {
              tokenUsage: { uncachedInputTokens: 100, outputTokens: 50, cacheReadTokens: 900, cacheWriteTokens: 0 },
              contextPressure: { pressureTokens: 1000, surfaceTokens: 2000, contextWindow: 100000 },
            },
          }),
        };
      }
      if (name === 'sessions') return { get: () => fakeSession };
      if (name === 'workspaceChanges') return { summary: () => null, diff: async () => null };
      return undefined;
    };
    const bridge = new HostBridge(ctx);
    const usage = bridge.getUsage('s1');
    assert.ok(usage);
    assert.equal(usage.tokens.input, 100);
    assert.equal(usage.tokens.total, 1050);
    assert.equal(usage.context.contextWindow, 100000);
    bridge.dispose();
  });

  await test('search falls back to titles when full-text search is disabled', async () => {
    const { ctx } = createFakeCtx();
    ctx.sessionController.search = async () => {
      throw Object.assign(new Error('session search failed: SESSION_QUERY_SEARCH_DISABLED'), { code: 'gateway/internal' });
    };
    const bridge = new HostBridge(ctx);
    const result = await bridge.search('真实');
    assert.equal(result.mode, 'title');
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].title, '真实标题');
    bridge.dispose();
  });

  await test('failure paths throw instead of pretending success', async () => {
    const { ctx } = createFakeCtx();
    ctx.sessionController.prompt = async () => {
      throw Object.assign(new Error('session is busy'), { code: 'session/agent-busy' });
    };
    const bridge = new HostBridge(ctx);
    await assert.rejects(() => bridge.prompt('s1', 'x', 'r'), /session is busy/);
    bridge.dispose();
  });

  console.log('');
  console.log('HostBridge Passed: ' + results.passed + '  Failed: ' + results.failed);
  if (results.failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
