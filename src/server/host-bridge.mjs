import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import {
  applyEvent,
  basenameOfPath,
  createMessageState,
  foldRecords,
  modelSelectionOf,
  expandAssistantStreamBaseline,
  normalizeAssistantStreamFrame,
  relativeTime,
  resetMessageState,
  snippetOf,
  statsOf,
  timeBucket,
  titleOf,
} from './protocol.mjs';

const LIST_CACHE_MS = 1200;
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_PROMPT = 8;
const UPLOAD_TTL_MS = 10 * 60 * 1000;
// Hard bound on staged bytes: 10MB x unbounded receipts would otherwise be a memory DoS
// from a paired phone. Evict oldest first once either bound is exceeded.
const MAX_STAGED_UPLOADS = 24;
const MAX_STAGED_BYTES = 64 * 1024 * 1024;
const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

function uploadError(message, statusCode, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (code) error.code = code;
  return error;
}

function imageMagicMatches(buffer, mediaType) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return false;
  if (mediaType === 'image/png') {
    return buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  if (mediaType === 'image/jpeg') return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (mediaType === 'image/gif') return buffer.subarray(0, 6).toString('ascii') === 'GIF87a' || buffer.subarray(0, 6).toString('ascii') === 'GIF89a';
  if (mediaType === 'image/webp') return buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
  return false;
}

function normalizeUploadName(value) {
  if (value === undefined || value === null) return undefined;
  const name = String(value).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200);
  return name || undefined;
}
const CATALOG_CACHE_MS = 5000;
const HISTORY_MESSAGES = 60;
const FOLLOW_MESSAGES = 50;

function abortSignal() {
  return new AbortController().signal;
}

/**
 * Collect turn start/end timestamps from durable records so clients can render
 * the same "已完成，用时 X" disclosure the desktop client shows.
 */
function collectTurnTimings(records) {
  const byTurn = new Map();
  for (const record of records || []) {
    const event = record && record.event;
    if (!event || !event.data) continue;
    const turn = event.data.turn;
    if (!Number.isSafeInteger(turn)) continue;
    if (event.type === 'turn/start') {
      const entry = byTurn.get(turn) || { turn, startedAt: null, endedAt: null, reasonKind: null };
      entry.startedAt = event.time;
      byTurn.set(turn, entry);
    } else if (event.type === 'turn/end') {
      const entry = byTurn.get(turn) || { turn, startedAt: null, endedAt: null, reasonKind: null };
      entry.endedAt = event.time;
      entry.reasonKind = (event.data.reason && event.data.reason.kind) || 'completed';
      byTurn.set(turn, entry);
    }
  }
  return [...byTurn.values()].sort((left, right) => left.turn - right.turn);
}

function normalizeSlashes(path) {
  return String(path || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/**
 * Host-side bridge over the real DSH services.
 *
 * All capabilities below are synchronous or promise based calls into the
 * running Host process (ctx.sessionController, ctx.workspaceRegistry,
 * ctx.workspaceChanges and the global event bus). No storage files are parsed
 * directly and no data is mocked here.
 */
export class HostBridge extends EventEmitter {
  constructor(ctx) {
    super();
    this.ctx = ctx || null;
    this.startedAt = Date.now();
    this.version = '2.0.0';
    this._listeners = [];
    this._listCache = { at: 0, data: null };
    this._catalogCache = { at: 0, data: null };
    this._workspaceCache = { at: 0, data: null };
    this._uploads = new Map();
    this._running = new Map();
    this._summaries = new Map();
    this.disposed = false;
    this.setupListeners();
  }

  get available() {
    return Boolean(this.ctx && this.ctx.sessionController && this.ctx.workspaceRegistry);
  }

  get sessionController() {
    return this.ctx && this.ctx.sessionController;
  }

  get workspaceRegistry() {
    return this.ctx && this.ctx.workspaceRegistry;
  }

  get workspaceChanges() {
    return this.ctx && typeof this.ctx.get === 'function' ? this.ctx.get('workspaceChanges') : undefined;
  }

  setupListeners() {
    if (!this.ctx || typeof this.ctx.on !== 'function') return;
    const listen = (event, handler) => {
      this.ctx.on(event, handler, { global: true });
      this._listeners.push([event, handler]);
    };

    listen('api-session/status', (sessionId, running) => {
      const id = String(sessionId);
      this._running.set(id, running === true);
      this.invalidateList();
      this.emit('status', { sessionId: id, running: running === true });
    });

    listen('api-session/added', (summary) => {
      this.invalidateList();
      this.emit('session-changed', { kind: 'added', summary });
    });

    listen('api-session/removed', (sessionId) => {
      this.invalidateList();
      this._running.delete(String(sessionId));
      this._summaries.delete(String(sessionId));
      this.emit('session-changed', { kind: 'removed', sessionId: String(sessionId) });
    });

    listen('api-session/activity', (sessionId, updatedAt) => {
      this.invalidateList();
      this.emit('session-changed', { kind: 'activity', sessionId: String(sessionId), updatedAt });
    });

    listen('api-session/error', (sessionId, message) => {
      this.emit('session-changed', { kind: 'error', sessionId: String(sessionId), message: String(message || '') });
    });

    listen('agent/assistant-stream', ({ agent, frame }) => {
      const sessionId = agent && agent.session && agent.session.id;
      if (!sessionId || !frame) return;
      this.emit('assistant-stream', { sessionId: String(sessionId), frame });
    });
  }

  invalidateList() {
    this._listCache.at = 0;
  }

  dispose() {
    this.disposed = true;
    for (const [event, handler] of this._listeners) {
      try {
        this.ctx.off(event, handler);
      } catch {
        /* ignore */
      }
    }
    this._listeners = [];
    this.removeAllListeners();
    this._listCache = { at: 0, data: null };
    this._catalogCache = { at: 0, data: null };
    this._summaries.clear();
    this._running.clear();
  }

  // ── workspaces ────────────────────────────────────────────────────────────

  listWorkspaces() {
    const now = Date.now();
    if (this._workspaceCache.data && now - this._workspaceCache.at < LIST_CACHE_MS) {
      return this._workspaceCache.data;
    }
    const registry = this.workspaceRegistry;
    const entities = registry ? registry.list() : [];
    const workspaces = entities.map((entity) => ({
      id: String(entity.id),
      title: String(entity.title || basenameOfPath(entity.path) || '工作区'),
      path: entity.path || null,
      sessionCount: Array.isArray(entity.sessionIds) ? entity.sessionIds.length : 0,
    }));
    this._workspaceCache = { at: now, data: workspaces };
    return workspaces;
  }

  matchWorkspaceByCwd(cwd, workspaces) {
    if (!cwd) return null;
    const target = normalizeSlashes(cwd);
    let best = null;
    let bestLength = -1;
    for (const workspace of workspaces) {
      if (!workspace.path) continue;
      const candidate = normalizeSlashes(workspace.path);
      if (!candidate) continue;
      if ((target === candidate || target.startsWith(candidate + '/')) && candidate.length > bestLength) {
        best = workspace;
        bestLength = candidate.length;
      }
    }
    return best;
  }

  // ── session list ──────────────────────────────────────────────────────────

  summaryToUi(item, workspaces, sessionWorkspaceMap) {
    const id = String(item.sessionId);
    const workspace = sessionWorkspaceMap.get(id) || this.matchWorkspaceByCwd(item.cwd, workspaces);
    const title = titleOf(item);
    const stats = statsOf(item);
    const model = modelSelectionOf(item);
    const updatedAt = Number(item.updatedAt) || 0;
    const running = this._running.has(id) ? this._running.get(id) === true : item.running === true;
    if (!this._running.has(id)) this._running.set(id, running);
    const summary = {
      id,
      title,
      workspaceId: workspace ? workspace.id : 'cwd:' + (item.cwd || ''),
      workspaceTitle: workspace ? workspace.title : basenameOfPath(item.cwd) || '未分组',
      workspacePath: workspace ? workspace.path : item.cwd || null,
      cwd: item.cwd || null,
      createdAt: updatedAt,
      updatedAt,
      running,
      blank: item.blank === true,
      agentAvailable: item.agentAvailable === true,
      turns: stats.turns,
      steps: stats.steps,
      model,
      timeBucket: timeBucket(updatedAt),
      relativeTime: relativeTime(updatedAt),
    };
    this._summaries.set(id, summary);
    return summary;
  }

  buildSessionWorkspaceMap(workspaces) {
    const map = new Map();
    const registry = this.workspaceRegistry;
    if (!registry) return map;
    for (const entity of registry.list()) {
      const ws = { id: String(entity.id), title: String(entity.title || basenameOfPath(entity.path) || '工作区'), path: entity.path || null };
      for (const sessionId of entity.sessionIds || []) map.set(String(sessionId), ws);
    }
    return map;
  }

  async listSessions(force = false) {
    const now = Date.now();
    if (!force && this._listCache.data && now - this._listCache.at < LIST_CACHE_MS) {
      return this._listCache.data;
    }
    const controller = this.sessionController;
    if (!controller) throw new Error('sessionController service is unavailable');
    const registry = this.workspaceRegistry;
    const archived = new Set(registry ? (registry.archivedSessionIds || []).map(String) : []);
    const workspaces = this.listWorkspaces();
    const sessionWorkspaceMap = this.buildSessionWorkspaceMap(workspaces);
    const result = await controller.list({}, abortSignal());
    const sessions = [];
    for (const item of result.items || []) {
      if (!item || !item.sessionId) continue;
      if (item.origin === 'subagent') continue;
      const id = String(item.sessionId);
      if (archived.has(id)) continue;
      sessions.push(this.summaryToUi(item, workspaces, sessionWorkspaceMap));
    }
    sessions.sort((left, right) => right.updatedAt - left.updatedAt);
    const data = {
      workspaces,
      sessions,
      counts: {
        workspaces: workspaces.length,
        sessions: sessions.length,
        running: sessions.filter((session) => session.running).length,
      },
    };
    this._listCache = { at: now, data };
    return data;
  }

  getCachedSummary(sessionId) {
    return this._summaries.get(String(sessionId)) || null;
  }

  async getSessionSummary(sessionId, { force = false } = {}) {
    const id = String(sessionId);
    const cached = this._summaries.get(id);
    if (cached && !force && Date.now() - this._listCache.at < LIST_CACHE_MS) return cached;
    // Refresh through the list so a cold session gets its projections too.
    try {
      const data = await this.listSessions(true);
      const found = data.sessions.find((session) => session.id === id);
      if (found) return found;
    } catch {
      /* fall through */
    }
    if (cached) return cached;
    return null;
  }

  isRunning(sessionId) {
    const id = String(sessionId);
    if (this._running.has(id)) return this._running.get(id) === true;
    const summary = this._summaries.get(id);
    return summary ? summary.running === true : false;
  }

  // ── model catalog ─────────────────────────────────────────────────────────

  async getModels(force = false) {
    const now = Date.now();
    if (!force && this._catalogCache.data && now - this._catalogCache.at < CATALOG_CACHE_MS) {
      return this._catalogCache.data;
    }
    const controller = this.sessionController;
    if (!controller) throw new Error('sessionController service is unavailable');
    const catalog = await controller.modelCatalog();
    const data = {
      groups: Array.isArray(catalog.groups) ? catalog.groups : [],
      default: catalog.default || null,
      failures: Array.isArray(catalog.failures) ? catalog.failures : [],
      routableProviders: Array.isArray(catalog.routableProviders) ? catalog.routableProviders : [],
    };
    this._catalogCache = { at: now, data };
    return data;
  }

  async getBootstrap() {
    const [list, models] = await Promise.all([this.listSessions(true), this.getModels()]);
    return {
      server: {
        version: this.version,
        hostName: process.env.COMPUTERNAME || 'DSH Host',
        platform: process.platform,
        protocol: 1,
        startedAt: this.startedAt,
      },
      counts: list.counts,
      workspaces: list.workspaces,
      sessions: list.sessions,
      models,
      defaultModel: models.default,
      approvals: this.approvalCapability ? this.approvalCapability() : { forwarding: false, policy: 'unknown' },
      questions: {
        forwarding: this.questionsEnabled === true,
        serviceAvailable: !!(this.ctx && typeof this.ctx.get === 'function' && this.ctx.get('userQuestions')),
        stats: this.questionsStats ? this.questionsStats() : null,
      },
    };
  }

  /** Report whether tool approvals can reach the phone at all. */
  approvalCapability() {
    const approvalService = this.ctx && typeof this.ctx.get === 'function' ? this.ctx.get('approval') : undefined;
    const policy = approvalService && approvalService.config ? approvalService.config.policy : 'unknown';
    return {
      serviceAvailable: approvalService !== undefined,
      policy,
      // danger-full-access sets approval policy to "never": the Host never asks.
      askable: policy === 'ask',
      forwarding: this.forwardingEnabled === true,
      stats: this.approvalStats ? this.approvalStats() : null,
    };
  }

  // ── history ───────────────────────────────────────────────────────────────

  /**
   * Resolve the last committed event sequence of a session. SessionController.page
   * needs an explicit throughSeq (the durable cursor); -1 means "no events yet".
   */
  async resolveCursor(sessionId) {
    const controller = this.sessionController;
    if (!controller) throw new Error('sessionController service is unavailable');
    try {
      const projection = await controller.projections({ sessionId: String(sessionId) }, abortSignal());
      if (projection && Number.isSafeInteger(projection.asOfSeq) && projection.asOfSeq >= 0) {
        return projection.asOfSeq;
      }
    } catch {
      /* fall back to the direct inspection below */
    }
    try {
      const observation = await controller.inspect(String(sessionId));
      const events = (observation && observation.events) || [];
      return events.length > 0 ? events[events.length - 1].seq : -1;
    } catch {
      return -1;
    }
  }

  async readPage(sessionId, { beforeSeq, maxMessages = HISTORY_MESSAGES } = {}) {
    const controller = this.sessionController;
    if (!controller) throw new Error('sessionController service is unavailable');
    const cursor = await this.resolveCursor(sessionId);
    if (cursor < 0) return { records: [], hasMore: false };
    const request = {
      address: { kind: 'session', sessionId: String(sessionId) },
      throughSeq: cursor,
      maxMessages: Math.min(Math.max(Number(maxMessages) || HISTORY_MESSAGES, 1), 200),
    };
    if (Number.isSafeInteger(beforeSeq) && beforeSeq > 0) request.beforeSeq = beforeSeq;
    const signal = abortSignal();
    return controller.page(request, signal);
  }

  async getMessages(sessionId, options = {}) {
    const page = await this.readPage(sessionId, options);
    const records = page.records || [];
    const state = createMessageState();
    const changeSeqs = [];
    for (const record of records) {
      const event = record && record.event;
      if (!event) continue;
      if (event.type === 'workspace/changes') {
        changeSeqs.push(event);
        continue;
      }
      applyEvent(state, event);
    }
    const changes = [];
    for (const event of changeSeqs) {
      changes.push({
        seq: event.seq,
        turn: event.data ? event.data.turn : null,
        summary: this.getChanges(sessionId, event.seq),
      });
    }
    const oldestSeq = records.length > 0 && records[0].event ? records[0].event.seq : null;
    return {
      messages: state.messages,
      changes,
      deliverables: state.deliverables || [],
      turns: collectTurnTimings(records),
      hasMore: page.hasMore === true,
      oldestSeq,
    };
  }

  async getSessionDetail(sessionId) {
    const id = String(sessionId);
    const [summary, page] = await Promise.all([
      this.getSessionSummary(id, { force: true }),
      this.getMessages(id, { maxMessages: HISTORY_MESSAGES }),
    ]);
    const model = (summary && summary.model) || null;
    return {
      summary,
      model,
      running: this.isRunning(id),
      messages: page.messages,
      changes: page.changes,
      turns: page.turns,
      hasMore: page.hasMore,
      oldestSeq: page.oldestSeq,
      usage: this.getUsage(id),
    };
  }

  /**
   * Token usage + context occupancy for one session, read from the Host's
   * token-meter projections. Returns null when the projections are unavailable
   * (e.g. a deployment without the token-meter row) instead of inventing values.
   */
  getUsage(sessionId) {
    // Access optional services through ctx.get(): reading ctx.<service> directly throws
    // when this plugin did not declare that service in inject (cordis inject guard).
    const registry = this.ctx && typeof this.ctx.get === 'function' ? this.ctx.get('sessionProjections') : undefined;
    const sessions = this.ctx && typeof this.ctx.get === 'function' ? this.ctx.get('sessions') : undefined;
    if (!registry || !sessions || typeof registry.snapshot !== 'function') return null;
    const session = sessions.get(String(sessionId));
    if (!session) return null;
    try {
      const snapshot = registry.snapshot(session);
      const values = (snapshot && snapshot.values) || {};
      const usage = values.tokenUsage || null;
      const pressure = values.contextPressure || null;
      if (!usage && !pressure) return null;
      return {
        tokens: usage
          ? {
              input: Number(usage.uncachedInputTokens) || 0,
              output: Number(usage.outputTokens) || 0,
              cacheRead: Number(usage.cacheReadTokens) || 0,
              cacheWrite: Number(usage.cacheWriteTokens) || 0,
              total:
                (Number(usage.uncachedInputTokens) || 0) +
                (Number(usage.outputTokens) || 0) +
                (Number(usage.cacheReadTokens) || 0) +
                (Number(usage.cacheWriteTokens) || 0),
            }
          : null,
        context: pressure
          ? {
              pressureTokens: Number(pressure.pressureTokens) || 0,
              surfaceTokens: Number(pressure.surfaceTokens) || 0,
              contextWindow: Number(pressure.contextWindow) || 0,
            }
          : null,
      };
    } catch {
      return null;
    }
  }

  // ── account (DeepSeek login balance) ─────────────────────────────────────

  /**
   * Read the signed-in DeepSeek account projection. Balance needs a signed-in
   * credential; without one this reports "signed-out" instead of fake numbers.
   */
  async getAccount() {
    const account = this.ctx && typeof this.ctx.get === 'function' ? this.ctx.get('deepseekAccount') : undefined;
    if (!account) {
      return { available: false, reason: 'no-account-provider' };
    }
    try {
      const state = typeof account.getState === 'function' ? await account.getState() : null;
      const signedIn = !!(state && state.status === 'credential-stored');
      if (!signedIn) {
        return {
          available: true,
          signedIn: false,
          status: (state && state.status) || 'unknown',
          balance: null,
          bonusWallets: [],
        };
      }
      const client = {
        version: '2.0.0',
        locale: 'zh',
        timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
      };
      const result = typeof account.getBalance === 'function' ? await account.getBalance(client) : null;
      if (!result || result.status !== 'ready') {
        return { available: true, signedIn: true, status: 'failed', balance: null, bonusWallets: [] };
      }
      return {
        available: true,
        signedIn: true,
        status: 'ready',
        balance: Array.isArray(result.value) ? result.value : [],
        bonusWallets: Array.isArray(result.bonusWallets) ? result.bonusWallets : [],
      };
    } catch (error) {
      return { available: true, signedIn: false, status: 'error', error: String((error && error.message) || error), balance: null, bonusWallets: [] };
    }
  }

  // ── plugins (read-only inventory) ────────────────────────────────────────

  /** Read-only list of Loader plugin entries with display metadata. */
  async getPlugins() {
    const inventory = this.ctx && typeof this.ctx.get === 'function' ? this.ctx.get('pluginInventory') : undefined;
    if (!inventory || typeof inventory.list !== 'function') {
      return { available: false, entries: [] };
    }
    try {
      const data = await inventory.list();
      const entries = (data && data.entries) || [];
      return {
        available: true,
        managementAvailable: data && data.managementAvailable === true,
        entries: entries.map((entry) => ({
          entryId: String(entry.entryId || ''),
          moduleName: String(entry.moduleName || ''),
          enabled: entry.enabled !== false,
          phase: entry.fiberPhase === undefined ? null : entry.fiberPhase,
          title: (entry.meta && entry.meta.title) || null,
          description: (entry.meta && entry.meta.description) || null,
          icon: (entry.meta && entry.meta.icon) || null,
          // Rename-proof: accept the shipped name and the planned npm name.
          isRemoteControl: /(^|[/@])dsh(-mobile)?-remote-control$/.test(String(entry.moduleName || '')),
        })),
      };
    } catch (error) {
      return { available: false, entries: [], error: String((error && error.message) || error) };
    }
  }

  // ── changes / diffs ───────────────────────────────────────────────────────

  getChanges(sessionId, seq) {
    const service = this.workspaceChanges;
    if (!service || typeof service.summary !== 'function') return null;
    try {
      const summary = service.summary(String(sessionId), Number(seq));
      return summary || null;
    } catch {
      return null;
    }
  }

  async getDiff(sessionId, seq, index) {
    const service = this.workspaceChanges;
    if (!service || typeof service.diff !== 'function') return null;
    try {
      const diff = await service.diff(String(sessionId), Number(seq), Number(index), abortSignal());
      return diff || null;
    } catch {
      return null;
    }
  }

  // ── image uploads ─────────────────────────────────────────────────────────

  pruneImageUploads() {
    const now = Date.now();
    for (const [receiptId, upload] of this._uploads) {
      if (!upload || upload.expiresAt <= now) this._uploads.delete(receiptId);
    }
    // Bound total staged memory: drop the oldest entries until both limits hold.
    // Reserve one slot for the receipt the caller is about to add, so the cap is a
    // hard ceiling rather than a post-insert trim.
    while (this._uploads.size >= MAX_STAGED_UPLOADS) {
      const oldest = this._uploads.keys().next();
      if (oldest.done) break;
      this._uploads.delete(oldest.value);
    }
    let total = 0;
    for (const upload of this._uploads.values()) total += upload.bytes || 0;
    while (total > MAX_STAGED_BYTES) {
      const oldest = this._uploads.keys().next();
      if (oldest.done) break;
      const evicted = this._uploads.get(oldest.value);
      total -= (evicted && evicted.bytes) || 0;
      this._uploads.delete(oldest.value);
    }
  }

  /**
   * Stage one phone image and return an opaque, session-scoped, single-use receipt.
   * DSH prompt wire form for images is { type: 'image', mediaType, data } (see
   * session-controller typert.host.js PromptContentPart); file-upload receipts are
   * only valid for { type: 'file', receiptId }. We therefore stage the short-lived
   * receipt here and turn it into an encoded image at prompt time.
   */
  async uploadAttachment(sessionId, input) {
    const sid = String(sessionId || '').trim();
    if (!sid) throw uploadError('sessionId is required', 400, 'bad-request');
    const payload = input || {};
    const mediaType = String(payload.mediaType || '').trim().toLowerCase();
    if (!IMAGE_MEDIA_TYPES.has(mediaType)) throw uploadError('unsupported image media type', 415, 'unsupported-media-type');
    const raw = typeof payload.dataBase64 === 'string' ? payload.dataBase64.trim() : '';
    if (!raw) throw uploadError('dataBase64 is required', 400, 'bad-request');
    if (raw.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) throw uploadError('dataBase64 is not canonical base64', 400, 'invalid-base64');
    const buffer = Buffer.from(raw, 'base64');
    if (!buffer.length || buffer.toString('base64') !== raw) throw uploadError('dataBase64 is not canonical base64', 400, 'invalid-base64');
    if (buffer.length > MAX_UPLOAD_BYTES) throw uploadError('image exceeds ' + MAX_UPLOAD_BYTES + ' bytes', 413, 'upload-too-large');
    if (!imageMagicMatches(buffer, mediaType)) throw uploadError('image bytes do not match mediaType', 400, 'invalid-image');
    const name = normalizeUploadName(payload.name);
    this.pruneImageUploads();
    const receiptId = crypto.randomUUID();
    const now = Date.now();
    this._uploads.set(receiptId, {
      receiptId,
      sessionId: sid,
      mediaType,
      dataBase64: raw,
      bytes: buffer.length,
      ...(name ? { name } : {}),
      createdAt: now,
      expiresAt: now + UPLOAD_TTL_MS,
    });
    return { receiptId, mediaType, bytes: buffer.length, ...(name ? { name } : {}) };
  }

  resolvePromptAttachments(sessionId, attachments) {
    if (attachments === undefined || attachments === null) return { parts: [], receiptIds: [] };
    if (!Array.isArray(attachments)) throw uploadError('attachments must be an array', 400, 'bad-attachments');
    if (attachments.length > MAX_ATTACHMENTS_PER_PROMPT) throw uploadError('too many attachments (max ' + MAX_ATTACHMENTS_PER_PROMPT + ')', 400, 'too-many-attachments');
    this.pruneImageUploads();
    const sid = String(sessionId || '');
    const parts = [];
    const receiptIds = [];
    attachments.forEach((entry, index) => {
      const receiptId = typeof entry === 'string' ? entry : entry && entry.receiptId;
      if (!receiptId) throw uploadError('attachments[' + index + '].receiptId is required', 400, 'bad-attachments');
      const upload = this._uploads.get(String(receiptId));
      if (!upload) throw uploadError('image upload expired or unknown; please upload again', 410, 'upload-expired');
      if (upload.sessionId !== sid) throw uploadError('image upload belongs to another session', 403, 'upload-session-mismatch');
      parts.push({
        type: 'image',
        mediaType: upload.mediaType,
        data: upload.dataBase64,
        ...(upload.name ? { name: upload.name } : {}),
      });
      receiptIds.push(upload.receiptId);
    });
    return { parts, receiptIds };
  }

  // ── attachments ───────────────────────────────────────────────────────────

  async getAttachment(sessionId, attachmentId) {
    const controller = this.sessionController;
    if (!controller) throw new Error('sessionController service is unavailable');
    const result = await controller.attachment({ sessionId: String(sessionId), attachmentId: String(attachmentId) });
    const mediaType = (result.attachment && result.attachment.mediaType) || 'image/png';
    return {
      attachment: result.attachment,
      dataUrl: 'data:' + mediaType + ';base64,' + result.data,
    };
  }

  // ── commands ──────────────────────────────────────────────────────────────

  async prompt(sessionId, text, requestId, attachments) {
    const controller = this.sessionController;
    if (!controller) throw new Error('sessionController service is unavailable');
    const textContent = String(text || '').trim();
    const resolved = this.resolvePromptAttachments(sessionId, attachments);
    if (!textContent && resolved.parts.length === 0) throw uploadError('prompt text or image attachment is required', 400, 'empty-prompt');
    const content = [...resolved.parts];
    if (textContent) content.push({ type: 'text', text: textContent });
    const result = await controller.prompt(
      {
        sessionId: String(sessionId),
        requestId: String(requestId || 'remote-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)),
        content,
      },
      abortSignal(),
    );
    for (const receiptId of resolved.receiptIds) this._uploads.delete(receiptId);
    this.invalidateList();
    return { ok: true, accepted: result ? result.accepted !== false : true };
  }

  async cancel(sessionId) {
    const controller = this.sessionController;
    if (!controller) throw new Error('sessionController service is unavailable');
    const result = await controller.cancel({ sessionId: String(sessionId) });
    return { ok: true, accepted: result ? result.accepted !== false : true };
  }

  async selectModel(sessionId, provider, model, reasoningEffort) {
    const controller = this.sessionController;
    if (!controller) throw new Error('sessionController service is unavailable');
    if (!provider || !model) throw new Error('provider and model are required');
    const result = await controller.selectModel({
      sessionId: String(sessionId),
      provider: String(provider),
      model: String(model),
      ...(reasoningEffort ? { reasoningEffort: String(reasoningEffort) } : {}),
    });
    this.invalidateList();
    return { ok: true, selection: (result && result.selected) || { provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) } };
  }

  async rename(sessionId, title) {
    const controller = this.sessionController;
    if (!controller) throw new Error('sessionController service is unavailable');
    const result = await controller.rename({ sessionId: String(sessionId), title: String(title || '') });
    this.invalidateList();
    return { ok: true, title: (result && result.title) || String(title || ''), seq: result ? result.seq : null };
  }

  async createSession({ workspaceId, cwd, agentPreset } = {}) {
    const controller = this.sessionController;
    if (!controller) throw new Error('sessionController service is unavailable');
    const request = {};
    if (workspaceId) request.workspaceId = String(workspaceId);
    else if (cwd) request.cwd = String(cwd);
    if (agentPreset) request.agentPreset = String(agentPreset);
    const result = await controller.create(request);
    this.invalidateList();
    return { sessionId: String(result.sessionId), agentPreset: result.agentPreset };
  }

  async search(query) {
    const controller = this.sessionController;
    if (!controller) throw new Error('sessionController service is unavailable');
    const text = String(query || '').trim();
    if (!text) return { items: [], hasMore: false };
    const list = await this.listSessions().catch(() => null);
    const summaries = this._summaries;
    try {
      const result = await controller.search({ query: text }, abortSignal());
      const items = (result.items || []).map((hit) => {
        const summary = summaries.get(String(hit.sessionId));
        return {
          sessionId: String(hit.sessionId),
          snippet: snippetOf(hit.snippet),
          title: summary ? summary.title : '未命名任务',
          workspaceTitle: summary ? summary.workspaceTitle : '',
          updatedAt: summary ? summary.updatedAt : 0,
        };
      });
      return { items, hasMore: result.hasMore === true, mode: 'content' };
    } catch (error) {
      // Full-text search is opt-in in DSH (session-query openAt: never keeps it
      // disabled by default). Fall back to title/workspace matching so the
      // phone search box still works in every deployment.
      if (!list) throw error;
      const needle = text.toLowerCase();
      const items = list.sessions
        .filter((session) => session.title.toLowerCase().includes(needle) || (session.workspaceTitle || '').toLowerCase().includes(needle))
        .slice(0, 20)
        .map((session) => ({
          sessionId: session.id,
          snippet: session.title,
          title: session.title,
          workspaceTitle: session.workspaceTitle,
          updatedAt: session.updatedAt,
        }));
      return { items, hasMore: false, mode: 'title' };
    }
  }

  // ── live follow ───────────────────────────────────────────────────────────

  /**
   * Follow one session and yield normalized UI frames. The caller owns the
   * AbortSignal and must iterate inside try/finally.
   */
  async *followSession(sessionId, signal) {
    const controller = this.sessionController;
    if (!controller) throw new Error('sessionController service is unavailable');
    const id = String(sessionId);
    const stream = controller.follow(
      {
        address: { kind: 'session', sessionId: id },
        maxMessages: FOLLOW_MESSAGES,
        assistantStream: true,
      },
      signal,
    );
    let state = createMessageState();
    for await (const frame of stream) {
      if (this.disposed) return;
      if (!frame || typeof frame !== 'object') continue;
      if (frame.type === 'snapshot') {
        state = resetMessageState(createMessageState());
        const changeEvents = [];
        for (const record of frame.records || []) {
          const event = record && record.event;
          if (!event) continue;
          if (event.type === 'workspace/changes') changeEvents.push(event);
          else applyEvent(state, event);
        }
        const changes = changeEvents.map((event) => ({
          seq: event.seq,
          turn: event.data ? event.data.turn : null,
          summary: this.getChanges(id, event.seq),
        }));
        const projections = (frame.projections && frame.projections.values) || {};
        const summary = (await this.getSessionSummary(id).catch(() => null)) || this.syntheticSummary(frame.header, projections, id);
        const model = (projections.modelSelection && (projections.modelSelection.next || projections.modelSelection.lastUsed)) || (summary && summary.model) || null;
        const normalizedModel = model && model.provider && model.model
          ? { provider: model.provider, model: model.model, ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {}) }
          : null;
        const oldestSeq = frame.records && frame.records.length > 0 && frame.records[0].event ? frame.records[0].event.seq : null;
        yield {
          type: 'opened',
          sessionId: id,
          data: {
            summary: this.applyLiveMeta(summary, projections, frame.header, id),
            model: normalizedModel,
            running: this.isRunning(id),
            messages: state.messages.slice(),
            changes: changes.slice(),
            turns: collectTurnTimings(frame.records),
            hasMore: frame.hasMore === true,
            oldestSeq,
          },
        };
        const baseline = expandAssistantStreamBaseline(frame.assistantStream);
        if (baseline.attemptId && (baseline.text || baseline.reasoning)) {
          yield {
            type: 'event',
            sessionId: id,
            event: { kind: 'stream-start', attemptId: baseline.attemptId, turn: baseline.turn, step: baseline.step },
          };
          if (baseline.text) {
            yield { type: 'event', sessionId: id, event: { kind: 'stream', attemptId: baseline.attemptId, block: 'text', text: baseline.text } };
          }
          if (baseline.reasoning) {
            yield { type: 'event', sessionId: id, event: { kind: 'stream', attemptId: baseline.attemptId, block: 'reasoning', text: baseline.reasoning } };
          }
        }
        continue;
      }
      if (frame.type === 'event') {
        const event = frame.event;
        if (!event) continue;
        if (event.type === 'workspace/changes') {
          yield {
            type: 'event',
            sessionId: id,
            event: {
              kind: 'changes',
              seq: event.seq,
              turn: event.data ? event.data.turn : null,
              summary: this.getChanges(id, event.seq),
            },
          };
          continue;
        }
        const produced = applyEvent(state, event);
        for (const item of produced) {
          if (item.kind === 'message') this.invalidateList();
          if (item.kind === 'status' && typeof item.running === 'boolean') {
            this._running.set(id, item.running);
          }
          yield { type: 'event', sessionId: id, event: item };
        }
        continue;
      }
      if (frame.type === 'assistant-stream') {
        for (const item of normalizeAssistantStreamFrame(frame.frame)) {
          yield { type: 'event', sessionId: id, event: item };
        }
      }
    }
  }

  syntheticSummary(header, projections, sessionId) {
    const title = typeof projections.title === 'string' && projections.title.trim() ? projections.title : '未命名任务';
    const stats = projections.sessionStats || {};
    const modelSelection = projections.modelSelection && (projections.modelSelection.next || projections.modelSelection.lastUsed);
    const updatedAt = Number(header && header.createdAt) || Date.now();
    return {
      id: String(sessionId),
      title,
      workspaceId: 'cwd:' + ((header && header.cwd) || ''),
      workspaceTitle: basenameOfPath(header && header.cwd) || '未分组',
      workspacePath: (header && header.cwd) || null,
      cwd: (header && header.cwd) || null,
      createdAt: updatedAt,
      updatedAt,
      running: this.isRunning(sessionId),
      blank: false,
      agentAvailable: true,
      turns: Number(stats.turns) || 0,
      steps: Number(stats.steps) || 0,
      model: modelSelection && modelSelection.provider && modelSelection.model
        ? { provider: modelSelection.provider, model: modelSelection.model, ...(modelSelection.reasoningEffort ? { reasoningEffort: modelSelection.reasoningEffort } : {}) }
        : null,
      timeBucket: timeBucket(updatedAt),
      relativeTime: relativeTime(updatedAt),
    };
  }

  applyLiveMeta(summary, projections, header, sessionId) {
    const base = summary || this.syntheticSummary(header, projections, sessionId);
    const title = typeof projections.title === 'string' && projections.title.trim() ? projections.title : base.title;
    const stats = projections.sessionStats || {};
    return {
      ...base,
      title,
      running: this.isRunning(sessionId),
      turns: Number(stats.turns) || base.turns || 0,
      steps: Number(stats.steps) || base.steps || 0,
      model: base.model,
    };
  }
}
