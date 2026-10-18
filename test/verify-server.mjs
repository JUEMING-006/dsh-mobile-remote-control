/**
 * Verification suite for the dsh-mobile-remote-control Host/server layer.
 * Runs against the standalone MockBridge (no DSH Host required).
 */
import assert from 'node:assert/strict';
import { RemoteControlServer } from '../src/server/http-server.mjs';
import { MockBridge } from '../src/server/mock-host.mjs';
import { applyEvent, createMessageState, timeBucket } from '../src/server/protocol.mjs';
import { ApprovalBridge } from '../src/server/approval-bridge.mjs';
import { QuestionsBridge } from '../src/server/questions-bridge.mjs';

const PORT = 52999;
const BASE = 'http://127.0.0.1:' + PORT;

const results = { passed: 0, failed: 0, failures: [] };

async function test(name, fn) {
  try {
    await fn();
    results.passed += 1;
    console.log('PASS  ' + name);
  } catch (error) {
    results.failed += 1;
    results.failures.push({ name, error });
    console.error('FAIL  ' + name);
    console.error('      ' + (error && error.stack ? error.stack.split('\n').slice(0, 4).join('\n      ') : error));
  }
}

function unitTests() {
  return [
    [
      'user/message -> user Message',
      () => {
        const state = createMessageState();
        const events = applyEvent(state, {
          type: 'user/message', seq: 1, time: 1000, surfaceOp: 'append',
          data: { id: 'u1', content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } },
        });
        assert.equal(events.length, 1);
        assert.equal(events[0].kind, 'message');
        assert.equal(events[0].message.role, 'user');
        assert.equal(events[0].message.blocks[0].text, 'hello');
        assert.equal(state.messages.length, 1);
      },
    ],
    [
      'assistant/message -> reasoning + tool-call blocks',
      () => {
        const state = createMessageState();
        const events = applyEvent(state, {
          type: 'assistant/message', seq: 2, time: 2000, surfaceOp: 'append',
          data: {
            turn: 1, step: 1,
            message: { id: 'a1', source: { kind: 'model', provider: 'p', model: 'm' }, content: [
              { type: 'reasoning', text: 'think' },
              { type: 'text', text: 'answer' },
              { type: 'tool-call', id: 'c1', name: 'read', arguments: '{"p":1}' },
            ] },
            usage: { inputTokens: 10, outputTokens: 5 },
          },
        });
        assert.equal(events.length, 1);
        const blocks = events[0].message.blocks;
        assert.deepEqual(blocks.map((block) => block.type), ['reasoning', 'text', 'tool']);
        assert.equal(events[0].message.usage.inputTokens, 10);
      },
    ],
    [
      'tool/result -> message-update on owning assistant message',
      () => {
        const state = createMessageState();
        applyEvent(state, {
          type: 'assistant/message', seq: 2, time: 2000, surfaceOp: 'append',
          data: { turn: 1, step: 1, message: { id: 'a1', content: [{ type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' }] } },
        });
        const events = applyEvent(state, {
          type: 'tool/result', seq: 3, time: 3000, surfaceOp: 'append',
          data: { turn: 1, step: 1, message: { toolCallId: 'c1', content: [{ type: 'text', text: 'file body' }], isError: false } },
        });
        assert.equal(events.length, 1);
        assert.equal(events[0].kind, 'message-update');
        const tool = events[0].message.blocks[0];
        assert.equal(tool.status, 'done');
        assert.equal(tool.output, 'file body');
      },
    ],
    [
      'turn/end error -> status + turn-end with error',
      () => {
        const state = createMessageState();
        const events = applyEvent(state, {
          type: 'turn/end', seq: 4, time: 4000,
          data: { turn: 1, reason: { kind: 'error', error: { message: 'quota', code: 'QUOTA' } } },
        });
        assert.deepEqual(events.map((event) => event.kind), ['status', 'turn-end']);
        assert.equal(events[1].ok, false);
        assert.equal(events[1].error.code, 'QUOTA');
      },
    ],
    [
      'timeBucket buckets',
      () => {
        const now = new Date('2026-10-18T12:00:00+08:00').getTime();
        assert.equal(timeBucket(now - 60 * 1000, now), '今天');
        assert.equal(timeBucket(now - 30 * 60 * 60 * 1000, now), '昨天');
        assert.equal(timeBucket(now - 2 * 24 * 60 * 60 * 1000, now), '2 天前');
        assert.equal(timeBucket(now - 5 * 24 * 60 * 60 * 1000, now), '上周');
        assert.equal(timeBucket(now - 40 * 24 * 60 * 60 * 1000, now), '更早');
      },
    ],
  ];
}

function createWsClient(url) {
  const client = { socket: new WebSocket(url), queue: [], waiters: [], closed: null };
  client.socket.addEventListener('message', (event) => {
    let payload;
    try {
      payload = JSON.parse(String(event.data));
    } catch {
      return;
    }
    const index = client.waiters.findIndex((waiter) => waiter.predicate(payload));
    if (index >= 0) {
      const waiter = client.waiters.splice(index, 1)[0];
      clearTimeout(waiter.timer);
      waiter.resolve(payload);
      return;
    }
    client.queue.push(payload);
  });
  client.socket.addEventListener('close', (event) => {
    client.closed = { code: event.code, reason: event.reason };
    for (const waiter of client.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('socket closed ' + event.code));
    }
  });
  client.waitFor = (predicate, timeoutMs = 4000) => new Promise((resolve, reject) => {
    const index = client.queue.findIndex(predicate);
    if (index >= 0) {
      const payload = client.queue.splice(index, 1)[0];
      resolve(payload);
      return;
    }
    const waiter = {
      predicate,
      resolve,
      reject,
      timer: setTimeout(() => {
        const at = client.waiters.indexOf(waiter);
        if (at >= 0) client.waiters.splice(at, 1);
        reject(new Error('timed out waiting for websocket message'));
      }, timeoutMs),
    };
    client.waiters.push(waiter);
  });
  client.ready = () => new Promise((resolve, reject) => {
    if (client.socket.readyState === 1) return resolve();
    const timer = setTimeout(() => reject(new Error('websocket open timeout')), 4000);
    client.socket.addEventListener('open', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
    client.socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('websocket error'));
    }, { once: true });
  });
  client.send = (payload) => client.socket.send(JSON.stringify(payload));
  client.close = () => client.socket.close();
  return client;
}

async function main() {
  for (const entry of unitTests()) {
    await test('unit: ' + entry[0], entry[1]);
  }

  const bridge = new MockBridge();
  const server = new RemoteControlServer(bridge, { port: PORT });
  const approvalCtx = { on() {}, off() {}, get: () => undefined };
  server.approval = new ApprovalBridge({ ctx: approvalCtx, hasWatcher: () => true, emit: () => {}, timeoutMs: 5000 });
  server.questions = new QuestionsBridge({ ctx: approvalCtx, hasWatcher: () => true, emit: () => {}, timeoutMs: 5000 });
  await server.start();

  const token = server.token;
  const authHeaders = { 'X-Remote-Token': token, 'Content-Type': 'application/json' };
  let wsClient = null;

  await test('http: health is public', async () => {
    const response = await fetch(BASE + '/api/health');
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.mode, 'mock');
  });

  await test('http: bootstrap requires token', async () => {
    const response = await fetch(BASE + '/api/bootstrap');
    assert.equal(response.status, 401);
  });

  await test('http: bootstrap returns real-shaped data', async () => {
    const response = await fetch(BASE + '/api/bootstrap', { headers: authHeaders });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.counts.workspaces, 2);
    assert.equal(body.counts.sessions, 4);
    assert.equal(body.sessions.length, 4);
    assert.ok(body.sessions[0].updatedAt > 0);
    assert.equal(body.models.groups.length, 2);
    assert.ok(body.defaultModel.provider);
  });

  await test('http: session detail and pagination', async () => {
    const detail = await (await fetch(BASE + '/api/sessions/mock-session-1', { headers: authHeaders })).json();
    assert.equal(detail.messages.length, 4);
    assert.equal(detail.messages[1].blocks[0].type, 'reasoning');
    assert.equal(detail.hasMore, false);
    assert.equal(detail.oldestSeq, 1);
    const page = await (await fetch(BASE + '/api/sessions/mock-session-1/history?beforeSeq=3', { headers: authHeaders })).json();
    assert.ok(Array.isArray(page.messages));
  });

  await test('http: workspace changes and diff', async () => {
    const changes = await (await fetch(BASE + '/api/sessions/mock-session-1/changes?seq=9', { headers: authHeaders })).json();
    assert.equal(changes.summary.total, 3);
    assert.equal(changes.summary.added, 412);
    const diff = await (await fetch(BASE + '/api/sessions/mock-session-1/changes/9/0', { headers: authHeaders })).json();
    assert.equal(diff.diff.kind, 'text');
    assert.ok(diff.diff.hunks.length > 0);
  });

  await test('http: search', async () => {
    const body = await (await fetch(BASE + '/api/search?q=' + encodeURIComponent('远程'), { headers: authHeaders })).json();
    assert.ok(body.items.length >= 1);
    assert.ok(body.items[0].title.length > 0);
  });

  await test('http: create session + prompt + cancel + model', async () => {
    const created = await (await fetch(BASE + '/api/sessions', {
      method: 'POST', headers: authHeaders, body: JSON.stringify({ workspaceId: 'ws-dsh-miniapp' }),
    })).json();
    assert.ok(created.sessionId);
    const prompt = await (await fetch(BASE + '/api/sessions/mock-session-1/prompt', {
      method: 'POST', headers: authHeaders, body: JSON.stringify({ text: 'hi', requestId: 'r1' }),
    })).json();
    assert.equal(prompt.ok, true);
    const cancel = await (await fetch(BASE + '/api/sessions/mock-session-1/cancel', {
      method: 'POST', headers: authHeaders, body: '{}',
    })).json();
    assert.equal(cancel.ok, true);
    const model = await (await fetch(BASE + '/api/sessions/mock-session-1/model', {
      method: 'POST', headers: authHeaders, body: JSON.stringify({ provider: 'deepseek-account', model: 'deepseek-v4-pro' }),
    })).json();
    assert.equal(model.ok, true);
    assert.equal(model.selection.model, 'deepseek-v4-pro');
  });

  await test('http: attachment failure is surfaced as 500', async () => {
    const response = await fetch(BASE + '/api/sessions/mock-session-1/attachment/sha256-x', { headers: authHeaders });
    assert.equal(response.status, 500);
  });

  await test('http: bootstrap reports approval capability honestly', async () => {
    const body = await (await fetch(BASE + '/api/bootstrap', { headers: authHeaders })).json();
    assert.ok(body.approvals, 'bootstrap must carry approvals capability');
    assert.equal(typeof body.approvals.askable, 'boolean');
    assert.equal(typeof body.approvals.forwarding, 'boolean');
    assert.equal(body.approvals.policy, 'ask');
  });

  await test('ws: approval-answer is rejected when nothing is pending', async () => {
    const tokenNow = server.token;
    const client = createWsClient('ws://127.0.0.1:' + PORT + '/ws?token=' + tokenNow);
    await client.ready();
    await client.waitFor((message) => message.type === 'hello');
    client.send({ type: 'approval-answer', requestId: 'nope', decision: 'allow' });
    const error = await client.waitFor((message) => message.type === 'error' && message.code === 'approval-gone');
    assert.equal(error.code, 'approval-gone');
    client.send({ type: 'approval-pending', sessionId: 'mock-session-1' });
    const pending = await client.waitFor((message) => message.type === 'approval-pending');
    assert.deepEqual(pending.data, []);
    client.close();
  });

  await test('http: account route reports balance honestly', async () => {
    const body = await (await fetch(BASE + '/api/account', { headers: authHeaders })).json();
    assert.equal(body.available, true);
    assert.equal(body.signedIn, true);
    assert.ok(Array.isArray(body.balance));
    assert.equal(body.balance[0].currency, 'CNY');
  });

  await test('http: plugins route is read-only inventory', async () => {
    const body = await (await fetch(BASE + '/api/plugins', { headers: authHeaders })).json();
    assert.equal(body.available, true);
    assert.ok(body.entries.length >= 1);
    const rc = body.entries.find((e) => e.isRemoteControl);
    assert.ok(rc, 'the plugin itself must appear in the inventory');
  });

  await test('http: session detail carries token usage', async () => {
    const detail = await (await fetch(BASE + '/api/sessions/mock-session-1', { headers: authHeaders })).json();
    assert.ok(detail.usage, 'usage must be present when the projection exists');
    assert.ok(detail.usage.tokens.total > 0);
    assert.ok(detail.usage.context.contextWindow > 0);
  });

  await test('http: bootstrap reports question capability', async () => {
    const body = await (await fetch(BASE + '/api/bootstrap', { headers: authHeaders })).json();
    assert.ok(body.questions, 'bootstrap must carry questions capability');
    assert.equal(typeof body.questions.forwarding, 'boolean');
  });

  await test('ws: question-answer refused when nothing is pending', async () => {
    const client = createWsClient('ws://127.0.0.1:' + PORT + '/ws?token=' + server.token);
    await client.ready();
    await client.waitFor((message) => message.type === 'hello');
    client.send({ type: 'question-answer', requestId: 'nope', answers: [] });
    const error = await client.waitFor((message) => message.type === 'error' && message.code === 'question-gone');
    assert.equal(error.code, 'question-gone');
    client.send({ type: 'question-pending', sessionId: 'mock-session-1' });
    const pending = await client.waitFor((message) => message.type === 'question-pending');
    assert.deepEqual(pending.data, []);
    client.close();
  });

  await test('desktop: state is loopback only and exposes pairing info', async () => {
    const state = await (await fetch(BASE + '/api/desktop/state')).json();
    assert.equal(state.state, 'ready');
    assert.equal(state.port, PORT);
    assert.ok(state.pairingUrl.includes('token='));
    assert.ok(state.qrDataUrl.startsWith('data:image/png;base64,'));
  });

  await test('ws: token validation rejects wrong token', async () => {
    const client = createWsClient('ws://127.0.0.1:' + PORT + '/ws?token=wrong');
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('close timeout')), 4000);
      client.socket.addEventListener('close', (event) => {
        clearTimeout(timer);
        try {
          assert.equal(event.code, 4003);
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
  });

  await test('ws: hello / open / prompt / cancel / model / error', async () => {
    wsClient = createWsClient('ws://127.0.0.1:' + PORT + '/ws?token=' + token);
    await wsClient.ready();
    await wsClient.waitFor((message) => message.type === 'hello');
    wsClient.send({ type: 'hello' });
    const hello = await wsClient.waitFor((message) => message.type === 'hello' && message.data && message.data.sessions);
    assert.ok(hello.data.sessions.length >= 4);

    wsClient.send({ type: 'open', sessionId: 'mock-session-1' });
    const opened = await wsClient.waitFor((message) => message.type === 'opened');
    assert.ok(opened.data.messages.length >= 4);
    assert.ok(Array.isArray(opened.data.changes));
    assert.ok(opened.data.summary.title.length > 0);

    wsClient.send({ type: 'prompt', sessionId: 'mock-session-1', text: '继续', requestId: 'ws-r1' });
    await wsClient.waitFor((message) => message.type === 'ack' && message.requestId === 'ws-r1');
    await wsClient.waitFor((message) => message.type === 'event' && message.event.kind === 'message' && message.event.message.role === 'user');
    await wsClient.waitFor((message) => message.type === 'event' && message.event.kind === 'stream');

    wsClient.send({ type: 'cancel', sessionId: 'mock-session-1', requestId: 'ws-r2' });
    await wsClient.waitFor((message) => message.type === 'ack' && message.requestId === 'ws-r2');

    wsClient.send({ type: 'model', sessionId: 'mock-session-1', provider: 'min', model: 'MiniMax-M3', requestId: 'ws-r3' });
    await wsClient.waitFor((message) => message.type === 'ack' && message.requestId === 'ws-r3');

    wsClient.send({ type: 'open', sessionId: 'mock-session-missing' });
    const error = await wsClient.waitFor((message) => message.type === 'error');
    assert.ok(error.message.length > 0);
  });

  await test('desktop: refresh rotates token and revokes clients', async () => {
    const before = server.token;
    const state = await (await fetch(BASE + '/api/desktop/refresh', { method: 'POST' })).json();
    assert.notEqual(server.token, before);
    assert.equal(state.state, 'ready');
    assert.ok(state.deviceCount >= 0);
    const oldTokenResponse = await fetch(BASE + '/api/bootstrap', { headers: { 'X-Remote-Token': before } });
    assert.equal(oldTokenResponse.status, 401);
  });

  await test('desktop: stop blocks mobile API until refresh', async () => {
    const stopped = await (await fetch(BASE + '/api/desktop/stop', { method: 'POST' })).json();
    assert.equal(stopped.state, 'stopped');
    const blocked = await fetch(BASE + '/api/bootstrap', { headers: { 'X-Remote-Token': server.token } });
    assert.equal(blocked.status, 403);
    await fetch(BASE + '/api/desktop/refresh', { method: 'POST' });
    const restored = await fetch(BASE + '/api/bootstrap', { headers: { 'X-Remote-Token': server.token } });
    assert.equal(restored.status, 200);
  });

  await test('desktop: legacy aliases keep the old desktop bundle working', async () => {
    const status = await (await fetch(BASE + '/api/status')).json();
    assert.equal(status.ready, true);
    const qr = await (await fetch(BASE + '/api/qr')).json();
    assert.ok(qr.qrDataUrl.startsWith('data:image/png'));
  });

  if (wsClient) wsClient.close();
  await server.stop();
  bridge.dispose();

  console.log('');
  console.log('Passed: ' + results.passed + '  Failed: ' + results.failed);
  if (results.failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
