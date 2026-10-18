import { WebSocketServer, WebSocket } from 'ws';

const HEARTBEAT_MS = 20000;

function send(ws, payload) {
  if (ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify(payload));
  } catch {
    /* socket is going away */
  }
}

function errorPayload(error, requestId) {
  const code = (error && (error.code || (error.details && error.details.code))) || 'internal';
  const message = error && error.message ? String(error.message) : String(error);
  return { type: 'error', ...(requestId ? { requestId } : {}), code, message };
}

/**
 * WebSocket hub for paired mobile clients.
 *
 * One logical follow stream per (connection, session) pair: the mobile client
 * only ever has one session open, and per-connection ownership keeps abort and
 * error reporting trivial.
 */
export class WsHub {
  constructor(server, bridge, access, approvalBridge = null, questionsBridge = null) {
    this.server = server;
    this.bridge = bridge;
    this.access = access; // { getToken(), getState() }
    this.approval = approvalBridge;
    this.questions = questionsBridge;
    this.clients = new Set();
    this._handlers = [];
    this.wss = new WebSocketServer({ server, path: '/ws', maxPayload: 2 * 1024 * 1024 });
    this.setupWss();
    this.setupBridgeEvents();
    this.startHeartbeat();
  }

  get deviceCount() {
    return this.clients.size;
  }

  /** Whether any connected phone is currently following that session. */
  hasWatcher(sessionId) {
    const id = String(sessionId);
    for (const ws of this.clients) {
      if (ws.follows && ws.follows.has(id)) return true;
    }
    return false;
  }

  /** Push one approval-related frame to phone(s) watching that session. */
  emitApproval(payload) {
    const sessionId = payload && payload.data && payload.data.sessionId;
    for (const ws of this.clients) {
      if (sessionId && !(ws.follows && ws.follows.has(String(sessionId)))) continue;
      send(ws, payload);
    }
  }

  /** Push one question-related frame to phone(s) watching that session. */
  emitQuestion(payload) {
    const sessionId = payload && payload.data && payload.data.sessionId;
    for (const ws of this.clients) {
      if (sessionId && !(ws.follows && ws.follows.has(String(sessionId)))) continue;
      send(ws, payload);
    }
  }

  setupWss() {
    this.wss.on('connection', (ws, req) => {
      const url = new URL(req.url || '', 'http://127.0.0.1');
      const token = url.searchParams.get('token');
      if (this.access.getState() !== 'ready') {
        ws.close(4001, 'remote control stopped');
        return;
      }
      if (!this.access.isTokenValid(token)) {
        ws.close(4003, 'invalid pairing token');
        return;
      }
      ws.isAlive = true;
      ws.follows = new Map();
      this.clients.add(ws);
      ws.on('pong', () => {
        ws.isAlive = true;
      });
      ws.on('message', (data) => {
        this.handleMessage(ws, data).catch((error) => send(ws, errorPayload(error)));
      });
      ws.on('close', () => {
        this.cleanupClient(ws);
      });
      ws.on('error', () => {
        this.cleanupClient(ws);
      });
      send(ws, {
        type: 'hello',
        data: {
          protocol: 1,
          version: this.bridge.version || '2.0.0',
          deviceCount: this.clients.size,
          serverTime: Date.now(),
        },
      });
    });
  }

  cleanupClient(ws) {
    if (ws.follows) {
      for (const record of ws.follows.values()) {
        try {
          record.controller.abort();
        } catch {
          /* ignore */
        }
      }
      ws.follows.clear();
    }
    this.clients.delete(ws);
  }

  startHeartbeat() {
    this._heartbeat = setInterval(() => {
      for (const ws of this.clients) {
        if (!ws.isAlive) {
          cleanupSafe(this, ws);
          try {
            ws.terminate();
          } catch {
            /* ignore */
          }
          continue;
        }
        ws.isAlive = false;
        try {
          ws.ping();
        } catch {
          cleanupSafe(this, ws);
        }
      }
    }, HEARTBEAT_MS);
    if (this._heartbeat.unref) this._heartbeat.unref();
  }

  setupBridgeEvents() {
    const onStatus = ({ sessionId, running }) => {
      this.broadcast({ type: 'session-meta', data: { sessionId, running } });
    };
    const onChanged = (payload) => {
      if (payload.kind === 'removed') {
        this.broadcast({ type: 'session-meta', data: { sessionId: payload.sessionId, removed: true } });
        return;
      }
      if (payload.kind === 'error') {
        this.broadcast({ type: 'event', sessionId: payload.sessionId, event: { kind: 'error', message: payload.message } });
        return;
      }
      this.broadcast({ type: 'session-meta', data: { sessionId: payload.sessionId, ...(payload.updatedAt ? { updatedAt: payload.updatedAt } : {}) } });
    };
    this.bridge.on('status', onStatus);
    this.bridge.on('session-changed', onChanged);
    this._handlers.push(['status', onStatus], ['session-changed', onChanged]);
  }

  broadcast(payload, filter) {
    for (const ws of this.clients) {
      if (filter && !filter(ws)) continue;
      send(ws, payload);
    }
  }

  async handleMessage(ws, raw) {
    let message;
    try {
      message = JSON.parse(String(raw));
    } catch {
      send(ws, { type: 'error', code: 'bad-json', message: 'message must be JSON' });
      return;
    }
    if (!message || typeof message.type !== 'string') {
      send(ws, { type: 'error', code: 'bad-request', message: 'message.type is required' });
      return;
    }
    const requestId = message.requestId;
    try {
      switch (message.type) {
        case 'ping':
          send(ws, { type: 'pong', timestamp: Date.now() });
          return;
        case 'approval-answer': {
          if (!this.approval) {
            send(ws, { type: 'error', requestId, code: 'approval-disabled', message: 'approval forwarding is not enabled' });
            return;
          }
          const accepted = this.approval.answer(message.requestId, message.decision);
          if (!accepted) {
            send(ws, { type: 'error', requestId, code: 'approval-gone', message: '审批已结束或已过期' });
            return;
          }
          send(ws, { type: 'ack', requestId, ok: true });
          return;
        }
        case 'question-answer': {
          if (!this.questions) {
            send(ws, { type: 'error', requestId, code: 'questions-disabled', message: 'question forwarding is not enabled' });
            return;
          }
          const ok = this.questions.answer(message.requestId, message.answers);
          if (!ok) {
            send(ws, { type: 'error', requestId, code: 'question-gone', message: '提问已结束、已过期，或答案不完整' });
            return;
          }
          send(ws, { type: 'ack', requestId, ok: true });
          return;
        }
        case 'question-pending': {
          const list = this.questions ? this.questions.pendingFor(message.sessionId) : [];
          send(ws, { type: 'question-pending', sessionId: String(message.sessionId || ''), data: list });
          return;
        }
        case 'approval-pending': {
          const list = this.approval ? this.approval.pendingFor(message.sessionId) : [];
          send(ws, { type: 'approval-pending', sessionId: String(message.sessionId || ''), data: list });
          return;
        }
        case 'hello': {
          const bootstrap = await this.bridge.getBootstrap();
          send(ws, { type: 'hello', data: { ...bootstrap, deviceCount: this.clients.size, protocol: 1 } });
          return;
        }
        case 'list': {
          const list = await this.bridge.listSessions(true);
          send(ws, { type: 'list', data: list });
          return;
        }
        case 'open': {
          await this.subscribe(ws, String(message.sessionId || ''));
          return;
        }
        case 'close': {
          this.unsubscribe(ws, String(message.sessionId || ''));
          return;
        }
        case 'history': {
          const page = await this.bridge.getMessages(String(message.sessionId || ''), {
            beforeSeq: Number(message.beforeSeq) || undefined,
            maxMessages: Number(message.maxMessages) || undefined,
          });
          send(ws, { type: 'history', sessionId: String(message.sessionId || ''), data: page });
          return;
        }
        case 'prompt': {
          const result = await this.bridge.prompt(String(message.sessionId || ''), message.text, message.requestId, message.attachments);
          send(ws, { type: 'ack', requestId, ok: true, ...result });
          this.bridge.invalidateList();
          return;
        }
        case 'cancel': {
          const result = await this.bridge.cancel(String(message.sessionId || ''));
          send(ws, { type: 'ack', requestId, ok: true, ...result });
          return;
        }
        case 'model': {
          const result = await this.bridge.selectModel(String(message.sessionId || ''), message.provider, message.model, message.reasoningEffort);
          send(ws, { type: 'ack', requestId, ok: true, selection: result.selection });
          this.broadcast({ type: 'session-meta', data: { sessionId: String(message.sessionId || ''), model: result.selection } });
          return;
        }
        case 'models': {
          const models = await this.bridge.getModels(true);
          send(ws, { type: 'models', data: models });
          return;
        }
        case 'usage': {
          send(ws, { type: 'usage', sessionId: String(message.sessionId || ''), data: this.bridge.getUsage(String(message.sessionId || '')) });
          return;
        }
        case 'account': {
          send(ws, { type: 'account', data: await this.bridge.getAccount() });
          return;
        }
        case 'plugins': {
          send(ws, { type: 'plugins', data: await this.bridge.getPlugins() });
          return;
        }
        case 'changes': {
          send(ws, {
            type: 'changes',
            sessionId: String(message.sessionId || ''),
            seq: Number(message.seq),
            data: { summary: this.bridge.getChanges(String(message.sessionId || ''), Number(message.seq)) },
          });
          return;
        }
        case 'diff': {
          const diff = await this.bridge.getDiff(String(message.sessionId || ''), Number(message.seq), Number(message.index));
          send(ws, {
            type: 'diff',
            sessionId: String(message.sessionId || ''),
            seq: Number(message.seq),
            index: Number(message.index),
            data: { diff },
          });
          return;
        }
        case 'search': {
          const result = await this.bridge.search(message.query);
          send(ws, { type: 'search', ...result });
          return;
        }
        case 'create': {
          const result = await this.bridge.createSession({
            workspaceId: message.workspaceId,
            cwd: message.cwd,
            agentPreset: message.agentPreset,
          });
          send(ws, { type: 'created', requestId, sessionId: result.sessionId });
          this.bridge.invalidateList();
          this.broadcast({ type: 'session-meta', data: { sessionId: result.sessionId, added: true } });
          return;
        }
        case 'rename': {
          const result = await this.bridge.rename(String(message.sessionId || ''), message.title);
          send(ws, { type: 'ack', requestId, ok: true, title: result.title });
          this.broadcast({ type: 'session-meta', data: { sessionId: String(message.sessionId || ''), title: result.title } });
          return;
        }
        default:
          send(ws, { type: 'error', code: 'unknown-action', message: 'unknown message type: ' + message.type, requestId });
      }
    } catch (error) {
      send(ws, errorPayload(error, requestId));
    }
  }

  /** Replay any pending approval the phone missed before subscribing. */
  replayApprovals(ws, sessionId) {
    if (!this.approval) return;
    for (const item of this.approval.pendingFor(sessionId)) {
      send(ws, { type: 'approval-request', data: item });
    }
    if (this.questions) {
      for (const item of this.questions.pendingFor(sessionId)) {
        send(ws, { type: 'question-request', data: item });
      }
    }
  }

  async subscribe(ws, sessionId) {
    if (!sessionId) throw Object.assign(new Error('sessionId is required'), { code: 'bad-request' });
    this.unsubscribe(ws, sessionId);
    const controller = new AbortController();
    const record = { controller, task: null };
    ws.follows.set(sessionId, record);
    this.replayApprovals(ws, sessionId);
    const iterator = this.bridge.followSession(sessionId, controller.signal);
    record.task = (async () => {
      try {
        for await (const frame of iterator) {
          if (ws.readyState !== WebSocket.OPEN || controller.signal.aborted) break;
          send(ws, frame);
        }
      } catch (error) {
        if (!controller.signal.aborted) send(ws, errorPayload(error));
      } finally {
        if (ws.follows && ws.follows.get(sessionId) === record) ws.follows.delete(sessionId);
      }
    })();
  }

  unsubscribe(ws, sessionId) {
    if (!ws.follows) return;
    const record = ws.follows.get(sessionId);
    if (!record) return;
    ws.follows.delete(sessionId);
    try {
      record.controller.abort();
    } catch {
      /* ignore */
    }
  }

  revokeAllClients(code = 4001, reason = 'token revoked') {
    for (const ws of this.clients) {
      this.cleanupClient(ws);
      try {
        ws.close(code, reason);
      } catch {
        /* ignore */
      }
    }
    this.clients.clear();
  }

  async close() {
    if (this._heartbeat) clearInterval(this._heartbeat);
    if (this.approval) {
      try {
        this.approval.dispose();
      } catch {
        /* ignore */
      }
    }
    if (this.questions) {
      try {
        this.questions.dispose();
      } catch {
        /* ignore */
      }
    }
    for (const [event, handler] of this._handlers) {
      try {
        this.bridge.off(event, handler);
      } catch {
        /* ignore */
      }
    }
    this._handlers = [];
    this.revokeAllClients(4001, 'server closing');
    await new Promise((resolve) => this.wss.close(resolve));
  }
}

function cleanupSafe(hub, ws) {
  try {
    hub.cleanupClient(ws);
  } catch {
    /* ignore */
  }
}
