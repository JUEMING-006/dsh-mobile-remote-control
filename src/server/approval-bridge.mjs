/**
 * Approval bridge: forwards DSH tool-approval waterfalls to paired phones.
 *
 * Only active when the session's approval policy is "ask"; under "never"
 * (e.g. danger-full-access) the Host never emits approval/request at all.
 *
 * Safety rules (verified against DSH 0.2.1-rc.2 sources):
 * - Never claim a request the phone cannot answer: no listener -> return next().
 * - Always leave an escape hatch: timeout / abort / disconnect -> next(), so the
 *   desktop UI or the Host's fail-closed path can still decide.
 * - One in-flight request per session; a newer one replaces (and delegates) the older.
 */
import { randomUUID } from 'node:crypto';

export const APPROVAL_TIMEOUT_DEFAULT_MS = 40000;
const MAX_PENDING = 32;

/**
 * @param {object} options
 * @param {object} options.ctx - plugin context (must support ctx.on with { global: true })
 * @param {(sessionId: string) => boolean} options.hasWatcher - whether a phone is subscribed to that session
 * @param {(payload: object) => void} options.emit - push a frame to subscribed phones
 * @param {() => boolean} options.isEnabled - feature gate
 */
export class ApprovalBridge {
  constructor(options) {
    this.ctx = options.ctx;
    this.hasWatcher = options.hasWatcher || (() => false);
    this.emit = options.emit || (() => {});
    this.isEnabled = options.isEnabled || (() => true);
    this.timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : APPROVAL_TIMEOUT_DEFAULT_MS;
    this.pending = new Map(); // requestId -> record
    this.bySession = new Map(); // sessionId -> requestId
    this._handler = null;
    this._disposed = false;
    this.stats = { seen: 0, forwarded: 0, answered: 0, delegated: 0, timedOut: 0 };
  }

  get enabled() {
    return !this._disposed && this.isEnabled() && typeof this.ctx?.on === 'function';
  }

  install() {
    if (!this.enabled) {
      return false;
    }
    this._handler = (request, next) => this.handle(request, next);
    // prepend: run BEFORE api-remotes' gateway forwarder, otherwise that listener claims
    // the waterfall first and blocks waiting for a Web client that may not be answering.
    this.ctx.on('approval/request', this._handler, { global: true, prepend: true });
    return true;
  }

  async handle(request, next) {
    if (!this.enabled) return next();
    this.stats.seen += 1;

    const agent = request && request.agent;
    const sessionId = agent && agent.session && agent.session.id;
    if (!sessionId || !request.toolName) return next();

    // No phone watching this session -> let the desktop handle it unchanged.
    if (!this.hasWatcher(String(sessionId))) {
      this.stats.delegated += 1;
      return next();
    }
    if (this.pending.size >= MAX_PENDING) {
      this.stats.delegated += 1;
      return next();
    }

    const requestId = 'apr-' + randomUUID();
    const displayReason = request.displayReason || null;
    const reasonText =
      (displayReason && (displayReason.zh || displayReason['zh-cn'] || displayReason.en)) ||
      request.reason ||
      '';
    const record = {
      requestId,
      sessionId: String(sessionId),
      toolName: String(request.toolName),
      callId: request.callId === undefined ? null : String(request.callId),
      reason: reasonText,
      createdAt: Date.now(),
      settled: false,
      settle: null,
    };
    const outcome = new Promise((resolve) => {
      record.settle = (value) => {
        if (record.settled) return;
        record.settled = true;
        resolve(value);
      };
    });

    this.pending.set(requestId, record);
    this.bySession.set(record.sessionId, requestId);
    this.stats.forwarded += 1;

    this.emit({
      type: 'approval-request',
      data: {
        requestId,
        sessionId: record.sessionId,
        toolName: record.toolName,
        callId: record.callId,
        reason: record.reason,
        timeoutMs: this.timeoutMs,
        expiresAt: record.createdAt + this.timeoutMs,
      },
    });

    // Escape hatches: timeout, caller abort, disposal.
    const timer = setTimeout(() => {
      if (record.settled) return;
      this.stats.timedOut += 1;
      this.cleanup(record, 'timeout');
      record.settle(null);
    }, this.timeoutMs);
    // Intentionally not unref'd: a pending approval keeps its turn open, and an
    // unref'd timer would let the process exit without ever settling the waterfall.

    const onAbort = () => {
      if (record.settled) return;
      this.cleanup(record, 'aborted');
      record.settle(null);
    };
    if (request.signal && typeof request.signal.addEventListener === 'function') {
      if (request.signal.aborted) {
        onAbort();
      } else {
        request.signal.addEventListener('abort', onAbort, { once: true });
      }
    }
    record.onAbort = onAbort;
    record.signal = request.signal || null;

    const result = await outcome;
    clearTimeout(timer);
    if (record.signal && record.onAbort) {
      try {
        record.signal.removeEventListener('abort', record.onAbort);
      } catch {
        /* ignore */
      }
    }
    this.cleanup(record, 'done');

    if (result === null || result === undefined) {
      this.stats.delegated += 1;
      return next();
    }
    this.stats.answered += 1;
    return result;
  }

  /** Answer a pending approval from a phone. Returns false when unknown/expired. */
  answer(requestId, decision) {
    const record = this.pending.get(String(requestId));
    if (!record || record.settled) return false;
    const outcome = decision === 'allow' ? 'allowed-once' : decision === 'reject' ? 'rejected' : null;
    if (!outcome) return false;
    record.settle(outcome);
    return true;
  }

  /** Tell phones a request is gone (e.g. desktop answered first). */
  cleanup(record, reason) {
    this.pending.delete(record.requestId);
    if (this.bySession.get(record.sessionId) === record.requestId) this.bySession.delete(record.sessionId);
    if (reason !== 'done') {
      this.emit({ type: 'approval-closed', data: { requestId: record.requestId, sessionId: record.sessionId, reason } });
    }
  }

  pendingFor(sessionId) {
    const id = this.bySession.get(String(sessionId));
    if (!id) return [];
    const record = this.pending.get(id);
    return record ? [this.publicView(record)] : [];
  }

  publicView(record) {
    return {
      requestId: record.requestId,
      sessionId: record.sessionId,
      toolName: record.toolName,
      callId: record.callId,
      reason: record.reason,
      timeoutMs: this.timeoutMs,
      expiresAt: record.createdAt + this.timeoutMs,
    };
  }

  dispose() {
    this._disposed = true;
    if (this._handler && typeof this.ctx?.off === 'function') {
      try {
        this.ctx.off('approval/request', this._handler);
      } catch {
        /* ignore */
      }
    }
    this._handler = null;
    for (const record of [...this.pending.values()]) {
      try {
        record.settle(null);
      } catch {
        /* ignore */
      }
      this.cleanup(record, 'disposed');
    }
    this.pending.clear();
    this.bySession.clear();
  }
}
