import { EventEmitter } from 'node:events';

const now = Date.now();
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const WORKSPACES = [
  { id: 'ws-dsh-miniapp', title: 'dsh-miniapp', path: 'D:/Users/jueming/Desktop/dsh-miniapp', sessionCount: 4 },
  { id: 'ws-maestro', title: 'MAESTRO', path: 'D:/MAESTRO', sessionCount: 3 },
];

const SESSIONS = [
  {
    id: 'mock-session-1',
    title: '移动端远程控制台重构',
    workspaceId: 'ws-dsh-miniapp',
    workspaceTitle: 'dsh-miniapp',
    workspacePath: 'D:/Users/jueming/Desktop/dsh-miniapp',
    cwd: 'D:/Users/jueming/Desktop/dsh-miniapp',
    createdAt: now - 2 * HOUR,
    updatedAt: now - 6 * MINUTE,
    running: true,
    blank: false,
    agentAvailable: true,
    turns: 3,
    steps: 18,
    model: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'max' },
  },
  {
    id: 'mock-session-2',
    title: '教师端与学生端前端项目',
    workspaceId: 'ws-maestro',
    workspaceTitle: 'MAESTRO',
    workspacePath: 'D:/MAESTRO',
    cwd: 'D:/MAESTRO',
    createdAt: now - 3 * DAY,
    updatedAt: now - 1 * DAY,
    running: false,
    blank: false,
    agentAvailable: true,
    turns: 18,
    steps: 301,
    model: { provider: 'codearts', model: 'deepseek-v4.1-flash' },
  },
  {
    id: 'mock-session-3',
    title: '仓库根目录构建脚本排查',
    workspaceId: 'ws-maestro',
    workspaceTitle: 'MAESTRO',
    workspacePath: 'D:/MAESTRO',
    cwd: 'D:/MAESTRO',
    createdAt: now - 5 * DAY,
    updatedAt: now - 4 * DAY,
    running: false,
    blank: false,
    agentAvailable: false,
    turns: 1,
    steps: 24,
    model: null,
  },
  {
    id: 'mock-session-4',
    title: '新任务',
    workspaceId: 'ws-dsh-miniapp',
    workspaceTitle: 'dsh-miniapp',
    workspacePath: 'D:/Users/jueming/Desktop/dsh-miniapp',
    cwd: 'D:/Users/jueming/Desktop/dsh-miniapp',
    createdAt: now - 8 * MINUTE,
    updatedAt: now - 8 * MINUTE,
    running: false,
    blank: true,
    agentAvailable: true,
    turns: 0,
    steps: 0,
    model: { provider: 'deepseek-account', model: 'deepseek-flash' },
  },
];

const SESSION_MESSAGES = {
  'mock-session-1': [
    {
      id: 'm1',
      seq: 1,
      role: 'user',
      time: now - 2 * HOUR,
      blocks: [{ type: 'text', text: '检查现在的项目情况，功能全部没有实现，实际的显示效果也不对，整体 UI 感觉 AI 味很严重。' }],
    },
    {
      id: 'm2',
      seq: 2,
      role: 'assistant',
      time: now - 2 * HOUR + 4000,
      turn: 1,
      step: 1,
      model: { provider: 'deepseek-account', model: 'deepseek-flash' },
      usage: { inputTokens: 8192, outputTokens: 512, cacheReadTokens: 2048 },
      blocks: [
        {
          type: 'reasoning',
          text: '先核对当前实现：后端 bridge 用不存在的 RPC 形状，前端会话页是静态假数据。应该改成进程内真实服务：sessionController、workspaceRegistry、workspaceChanges。',
        },
        {
          type: 'tool',
          callId: 'call-1',
          name: 'read',
          args: '{"file_path":"src/server/dsh-bridge.mjs"}',
          status: 'done',
          output: '350 行，getSessionDetail() 返回硬编码示例对话与 +990 -0 的假 diff。',
        },
        {
          type: 'text',
          text: '已确认问题：\n\n1. 会话详情是写死的示例对话与假 Diff；\n2. 发消息/打断/切模型调用不存在的接口，失败后静默返回成功；\n3. 移动端视觉与参考图（ZCode 浅色 iOS 风）不符。\n\n接下来会按真实 Host 服务重写协议层，再按参考图重做三视图。',
        },
      ],
    },
    {
      id: 'm3',
      seq: 3,
      role: 'user',
      time: now - 10 * MINUTE,
      blocks: [{ type: 'text', text: '先重建后端，然后重做移动端 UI，参考 .refs 里的图。' }],
    },
    {
      id: 'm4',
      seq: 4,
      role: 'assistant',
      time: now - 6 * MINUTE,
      turn: 2,
      step: 1,
      model: { provider: 'deepseek-account', model: 'deepseek-flash' },
      blocks: [
        { type: 'tool', callId: 'call-2', name: 'run_code', args: '{"description":"Write host bridge"}', status: 'running' },
        { type: 'text', text: '正在把 sessionController.list/page/follow 接到移动端协议上，并把 workspaceChanges 的真实 diff 渲染成改动卡。' },
      ],
    },
  ],
};

const CHANGES = {
  'mock-session-1': [
    {
      seq: 9,
      turn: 1,
      summary: {
        turn: 1,
        cwd: 'D:/Users/jueming/Desktop/dsh-miniapp',
        total: 3,
        added: 412,
        deleted: 388,
        files: [
          { path: 'src/server/dsh-bridge.mjs', display: 'src/server/dsh-bridge.mjs', added: 210, deleted: 350 },
          { path: 'src/web/index.html', display: 'src/web/index.html', added: 120, deleted: 20 },
          { path: 'client/index.js', display: 'client/index.js', added: 82, deleted: 18 },
        ],
      },
    },
  ],
};

const DIFFS = {
  '9:0': {
    kind: 'text',
    path: 'src/server/dsh-bridge.mjs',
    display: 'src/server/dsh-bridge.mjs',
    before: true,
    after: true,
    coarse: false,
    hunks: [
      {
        oldStart: 194,
        oldLines: 8,
        newStart: 194,
        newLines: 8,
        lines: [
          ' async getSessionDetail(sessionId) {',
          '-  const messages = [{ role: "user", content: "为什么我昨天说..." }];',
          '+  const detail = await this.getMessages(sessionId, {});',
          '   return {',
          '-    messages,',
          '+    messages: detail.messages,',
          '   };',
          ' }',
        ],
      },
    ],
  },
};

const MODELS = {
  groups: [
    {
      id: 'deepseek-account',
      name: 'DeepSeek',
      models: [
        { id: 'deepseek-flash', name: 'deepseek-flash', description: '1M context · text/image', reasoning: { efforts: [{ id: 'low', name: 'low' }, { id: 'high', name: 'high' }, { id: 'max', name: 'max' }], defaultEffort: 'max' } },
        { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', description: '1M context' },
      ],
    },
    {
      id: 'min',
      name: 'MINMAX',
      models: [
        { id: 'MiniMax-M3', name: 'MiniMax-M3', description: 'anthropic-messages' },
        { id: 'MiniMax M3.1-Flash-Preview', name: 'MiniMax M3.1-Flash-Preview', description: '1M context · text/image' },
      ],
    },
  ],
  default: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'max' },
  failures: [],
  routableProviders: ['deepseek-account', 'min'],
};

/**
 * Standalone mock Host used only by "node src/index.mjs" for UI integration.
 * It never pretends to be connected to a real DSH Host: the HTTP layer exposes
 * mode: "mock" in /api/health and /api/bootstrap.server.
 */
export class MockBridge extends EventEmitter {
  constructor() {
    super();
    this.version = '2.0.0-mock';
    this.startedAt = Date.now();
    this.mode = 'mock';
    this._messages = JSON.parse(JSON.stringify(SESSION_MESSAGES));
    this._running = new Map([['mock-session-1', true]]);
    this._nextSeq = 100;
    this._uploads = new Map();
    this._attachments = new Map();
  }

  get available() {
    return true;
  }

  dispose() {
    this.removeAllListeners();
  }

  listWorkspaces() {
    return WORKSPACES;
  }

  async listSessions() {
    const sessions = SESSIONS.map((session) => ({
      ...session,
      running: this._running.has(session.id) ? this._running.get(session.id) : session.running,
    }));
    const workspaces = WORKSPACES.map((workspace) => ({
      ...workspace,
      sessionCount: sessions.filter((session) => session.workspaceId === workspace.id).length,
    }));
    return {
      workspaces,
      sessions,
      counts: {
        workspaces: workspaces.length,
        sessions: sessions.length,
        running: sessions.filter((session) => session.running).length,
      },
    };
  }

  async getModels() {
    return MODELS;
  }

  async getBootstrap() {
    const list = await this.listSessions();
    return {
      server: { version: this.version, hostName: 'mock-host', platform: process.platform, protocol: 1, startedAt: this.startedAt, mode: 'mock' },
      counts: list.counts,
      workspaces: list.workspaces,
      sessions: list.sessions,
      models: MODELS,
      defaultModel: MODELS.default,
      approvals: { serviceAvailable: true, policy: 'ask', askable: true, forwarding: true },
      questions: { serviceAvailable: true, forwarding: true, stats: null },
    };
  }

  async getSessionSummary(sessionId) {
    const list = await this.listSessions();
    return list.sessions.find((session) => session.id === sessionId) || null;
  }

  isRunning(sessionId) {
    return this._running.get(sessionId) === true;
  }

  async getMessages(sessionId) {
    const all = this._messages[sessionId] || [];
    return {
      messages: JSON.parse(JSON.stringify(all)),
      changes: CHANGES[sessionId] || [],
      turns: sessionId === 'mock-session-1'
        ? [
            { turn: 1, startedAt: now - 2 * HOUR, endedAt: now - 2 * HOUR + 140000, reasonKind: 'completed' },
            { turn: 2, startedAt: now - 10 * MINUTE, endedAt: null, reasonKind: null },
          ]
        : [],
      hasMore: false,
      oldestSeq: all.length ? all[0].seq : null,
    };
  }

  async getSessionDetail(sessionId) {
    const summary = await this.getSessionSummary(sessionId);
    const page = await this.getMessages(sessionId);
    return {
      summary,
      model: summary ? summary.model : null,
      running: this.isRunning(sessionId),
      messages: page.messages,
      changes: page.changes,
      turns: page.turns,
      hasMore: false,
      oldestSeq: page.oldestSeq,
      usage: this.getUsage(sessionId),
    };
  }

  getChanges(sessionId, seq) {
    const list = CHANGES[sessionId] || [];
    const found = list.find((item) => item.seq === seq);
    return found ? found.summary : null;
  }

  async getDiff(sessionId, seq, index) {
    return DIFFS[seq + ':' + index] || null;
  }

  getUsage(sessionId) {
    if (sessionId !== 'mock-session-1') return null;
    return {
      tokens: { input: 18234, output: 5120, cacheRead: 130000, cacheWrite: 0, total: 153354 },
      context: { pressureTokens: 51200, surfaceTokens: 210000, contextWindow: 1000000 },
    };
  }

  async getAccount() {
    return {
      available: true,
      signedIn: true,
      status: 'ready',
      balance: [{ currency: 'CNY', balance: '42.80' }],
      bonusWallets: [{ currency: 'CNY', balance: '10.00' }],
    };
  }

  async getPlugins() {
    return {
      available: true,
      managementAvailable: true,
      entries: [
        { entryId: 'remote-control', moduleName: 'dsh-mobile-remote-control', enabled: true, phase: 'active', title: '移动端远程控制', description: '手机扫码控制正在运行的 DSH', icon: null, isRemoteControl: true },
        { entryId: 'session', moduleName: '@deepseek-ai/dsh-session', enabled: true, phase: 'active', title: null, description: null, icon: null, isRemoteControl: false },
        { entryId: 'agent-modes', moduleName: 'dsh-agent-modes', enabled: false, phase: null, title: 'Agent Modes', description: null, icon: null, isRemoteControl: false },
      ],
    };
  }

  async getAttachment(sessionId, attachmentId) {
    const stored = this._attachments.get(String(attachmentId));
    if (!stored) throw new Error('attachment not found');
    return {
      attachment: { attachmentId: String(attachmentId), mediaType: stored.mediaType, size: stored.bytes },
      dataUrl: 'data:' + stored.mediaType + ';base64,' + stored.dataBase64,
    };
  }

  async uploadAttachment(sessionId, input) {
    const payload = input || {};
    const mediaType = String(payload.mediaType || '').toLowerCase();
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mediaType)) {
      const error = new Error('unsupported image media type');
      error.statusCode = 415;
      throw error;
    }
    const dataBase64 = typeof payload.dataBase64 === 'string' ? payload.dataBase64.trim() : '';
    if (!dataBase64 || dataBase64.length % 4 !== 0 || Buffer.from(dataBase64, 'base64').toString('base64') !== dataBase64) {
      const error = new Error('dataBase64 is not canonical base64');
      error.statusCode = 400;
      throw error;
    }
    const bytes = Buffer.from(dataBase64, 'base64');
    if (bytes.length > 10 * 1024 * 1024) {
      const error = new Error('image exceeds 10485760 bytes');
      error.statusCode = 413;
      throw error;
    }
    const receiptId = 'mock-receipt-' + Math.random().toString(36).slice(2, 10);
    const attachmentId = 'mock-att-' + Math.random().toString(36).slice(2, 10);
    this._uploads.set(receiptId, { receiptId, sessionId: String(sessionId), mediaType, dataBase64, name: typeof payload.name === 'string' ? payload.name : undefined });
    this._attachments.set(attachmentId, { mediaType, dataBase64, bytes: bytes.length });
    return { receiptId, mediaType, bytes: bytes.length };
  }

  async prompt(sessionId, text, requestId, attachments) {
    const session = SESSIONS.find((item) => item.id === sessionId);
    if (!session) throw new Error('session not found');
    const blocks = [];
    for (const entry of Array.isArray(attachments) ? attachments : []) {
      const receiptId = entry && entry.receiptId;
      const uploaded = receiptId ? this._uploads.get(String(receiptId)) : undefined;
      if (!uploaded) {
        const error = new Error('image upload expired or unknown; please upload again');
        error.statusCode = 410;
        throw error;
      }
      let attachmentId = null;
      for (const [id, stored] of this._attachments) {
        if (stored.dataBase64 === uploaded.dataBase64) { attachmentId = id; break; }
      }
      blocks.push({ type: 'image', attachment: { attachmentId, mediaType: uploaded.mediaType }, attachmentId, mediaType: uploaded.mediaType });
    }
    const textContent = String(text || '').trim();
    if (!blocks.length && !textContent) throw Object.assign(new Error('prompt text or image attachment is required'), { statusCode: 400 });
    if (textContent) blocks.push({ type: 'text', text: textContent });
    const seq = ++this._nextSeq;
    const message = { id: 'mock-user-' + seq, seq, role: 'user', time: Date.now(), blocks };
    this._messages[sessionId] = this._messages[sessionId] || [];
    this._messages[sessionId].push(message);
    this._running.set(sessionId, true);
    this.emit('mock-event', { sessionId, event: { kind: 'message', message } });
    this.emit('mock-event', { sessionId, event: { kind: 'status', running: true } });
    setTimeout(() => this._simulateReply(sessionId, text), 120);
    return { ok: true, accepted: true };
  }

  _simulateReply(sessionId, text) {
    if (!this.isRunning(sessionId)) return;
    const attemptId = 'attempt-' + Date.now();
    this.emit('mock-event', { sessionId, event: { kind: 'stream-start', attemptId, turn: 99, step: 1 } });
    const reply =
      '收到：「' + text + '」\n\n' +
      '这是独立运行模式的模拟回复，仅用于界面联调；接入真实 DSH Host 后，这里会展示模型真实输出、工具调用与本轮文件改动。';
    const chunks = reply.match(/.{1,6}/g) || [reply];
    let index = 0;
    const timer = setInterval(() => {
      if (!this.isRunning(sessionId)) {
        clearInterval(timer);
        return;
      }
      if (index >= chunks.length) {
        clearInterval(timer);
        const seq = ++this._nextSeq;
        const message = {
          id: 'mock-assistant-' + seq,
          seq,
          role: 'assistant',
          time: Date.now(),
          turn: 99,
          step: 1,
          model: MODELS.default,
          blocks: [{ type: 'text', text: reply }],
        };
        this._messages[sessionId].push(message);
        this._running.set(sessionId, false);
        this.emit('mock-event', { sessionId, event: { kind: 'message', message } });
        this.emit('mock-event', { sessionId, event: { kind: 'status', running: false } });
        this.emit('mock-event', { sessionId, event: { kind: 'turn-end', turn: 99, ok: true } });
        return;
      }
      this.emit('mock-event', { sessionId, event: { kind: 'stream', attemptId, block: 'text', text: chunks[index++] } });
    }, 24);
    if (timer.unref) timer.unref();
  }

  async cancel(sessionId) {
    this._running.set(sessionId, false);
    this.emit('mock-event', { sessionId, event: { kind: 'status', running: false } });
    return { ok: true, accepted: true };
  }

  async selectModel(sessionId, provider, model, reasoningEffort) {
    const session = SESSIONS.find((item) => item.id === sessionId);
    if (session) session.model = { provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) };
    this.emit('mock-event', { sessionId, event: { kind: 'model', selection: session ? session.model : null } });
    return { ok: true, selection: session ? session.model : { provider, model } };
  }

  async rename(sessionId, title) {
    const session = SESSIONS.find((item) => item.id === sessionId);
    if (session) session.title = title;
    this.emit('session-changed', { kind: 'activity', sessionId, updatedAt: Date.now() });
    return { ok: true, title };
  }

  async createSession() {
    const id = 'mock-session-new-' + (SESSIONS.length + 1);
    const workspace = WORKSPACES[0];
    SESSIONS.unshift({
      id,
      title: '新任务',
      workspaceId: workspace.id,
      workspaceTitle: workspace.title,
      workspacePath: workspace.path,
      cwd: workspace.path,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      running: false,
      blank: true,
      agentAvailable: true,
      turns: 0,
      steps: 0,
      model: MODELS.default,
    });
    return { sessionId: id };
  }

  async search(query) {
    const text = String(query || '').toLowerCase();
    const items = SESSIONS.filter((session) => session.title.toLowerCase().includes(text)).map((session) => ({
      sessionId: session.id,
      snippet: session.title,
      title: session.title,
      workspaceTitle: session.workspaceTitle,
      updatedAt: session.updatedAt,
    }));
    return { items, hasMore: false };
  }

  async *followSession(sessionId, signal) {
    const summary = await this.getSessionSummary(sessionId);
    if (!summary) {
      const error = new Error('session not found');
      error.code = 'session/not-found';
      throw error;
    }
    const page = await this.getMessages(sessionId);
    yield {
      type: 'opened',
      sessionId,
      data: {
        summary,
        model: summary.model,
        running: this.isRunning(sessionId),
        messages: page.messages,
        changes: page.changes,
        turns: page.turns,
        hasMore: false,
        oldestSeq: page.oldestSeq,
      },
    };
    const queue = [];
    let wake = null;
    const onEvent = (payload) => {
      if (payload.sessionId !== sessionId) return;
      queue.push(payload.event);
      if (wake) {
        const resume = wake;
        wake = null;
        resume();
      }
    };
    const onAbort = () => {
      if (wake) {
        const resume = wake;
        wake = null;
        resume();
      }
    };
    this.on('mock-event', onEvent);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    try {
      while (!(signal && signal.aborted)) {
        const event = queue.shift();
        if (event === undefined) {
          await new Promise((resolve) => {
            wake = resolve;
          });
          continue;
        }
        yield { type: 'event', sessionId, event };
      }
    } finally {
      this.off('mock-event', onEvent);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }
}
