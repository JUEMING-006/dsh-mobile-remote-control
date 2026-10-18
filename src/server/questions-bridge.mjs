/**
 * Questions bridge: forwards DSH ask_user_question waterfalls to paired phones.
 *
 * Verified contract (DSH 0.2.1-rc.2):
 * - event: 'user-questions/request', waterfall, signature (this: Scoped<Agent>, request, next)
 * - request:  { questions: AskUserQuestionItem[], agent?: Agent, signal?, wait?: { callId, timed? } }
 * - response: { answers: [{ id, selected: string[], custom?: string }] }
 * - EVERY question in the batch must be answered exactly once (host enforces BAD_ANSWER).
 *
 * Same safety rules as the approval bridge: never claim what the phone cannot answer,
 * and always leave an escape hatch (timeout / abort / dispose -> next()).
 */
import { randomUUID } from 'node:crypto';

export const QUESTIONS_TIMEOUT_DEFAULT_MS = 90000;
const MAX_PENDING = 16;

export class QuestionsBridge {
  constructor(options) {
    this.ctx = options.ctx;
    this.hasWatcher = options.hasWatcher || (() => false);
    this.emit = options.emit || (() => {});
    this.isEnabled = options.isEnabled || (() => true);
    this.timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : QUESTIONS_TIMEOUT_DEFAULT_MS;
    this.pending = new Map(); // requestId -> record
    this._handler = null;
    this._disposed = false;
    this.stats = { seen: 0, forwarded: 0, answered: 0, delegated: 0, timedOut: 0 };
  }

  get enabled() {
    return !this._disposed && this.isEnabled() && typeof this.ctx?.on === 'function';
  }

  install() {
    if (!this.enabled) return false;
    this._handler = (request, next) => this.handle(request, next);
    // prepend: claim before the gateway forwarder (same reason as the approval bridge).
    this.ctx.on('user-questions/request', this._handler, { global: true, prepend: true });
    return true;
  }

  /** Normalize one question for the wire (only fields the phone can render). */
  static serializeQuestions(questions) {
    return (questions || [])
      .filter((item) => item && typeof item.id === 'string')
      .map((item) => ({
        id: item.id,
        question: String(item.question || ''),
        ...(item.detail ? { detail: String(item.detail) } : {}),
        ...(item.header ? { header: String(item.header) } : {}),
        multiSelect: item.multiSelect === true,
        options: Array.isArray(item.options)
          ? item.options
              .filter((option) => option && typeof option.label === 'string')
              .map((option) => ({
                label: option.label,
                ...(option.description ? { description: String(option.description) } : {}),
              }))
          : [],
      }));
  }

  async handle(request, next) {
    if (!this.enabled) return next();
    this.stats.seen += 1;

    const questions = request && request.questions;
    if (!Array.isArray(questions) || questions.length === 0) return next();
    const agent = request.agent;
    const sessionId = agent && agent.session && agent.session.id;
    // Without a session identity the phone has nothing to anchor the sheet to.
    if (!sessionId) {
      this.stats.delegated += 1;
      return next();
    }
    if (!this.hasWatcher(String(sessionId)) || this.pending.size >= MAX_PENDING) {
      this.stats.delegated += 1;
      return next();
    }

    const requestId = 'q-' + randomUUID();
    const record = {
      requestId,
      sessionId: String(sessionId),
      callId: request.wait && request.wait.callId ? String(request.wait.callId) : null,
      questions: QuestionsBridge.serializeQuestions(questions),
      createdAt: Date.now(),
      settled: false,
      settle: null,
    };
    if (record.questions.length !== questions.length) {
      // A question the phone cannot render would make the batch unanswerable.
      this.stats.delegated += 1;
      return next();
    }

    const answer = new Promise((resolve) => {
      record.settle = (value) => {
        if (record.settled) return;
        record.settled = true;
        resolve(value);
      };
    });
    this.pending.set(requestId, record);
    this.stats.forwarded += 1;

    this.emit({
      type: 'question-request',
      data: {
        requestId,
        sessionId: record.sessionId,
        callId: record.callId,
        questions: record.questions,
        timeoutMs: this.timeoutMs,
        expiresAt: record.createdAt + this.timeoutMs,
      },
    });

    const timer = setTimeout(() => {
      if (record.settled) return;
      this.stats.timedOut += 1;
      this.cleanup(record, 'timeout');
      record.settle(null);
    }, this.timeoutMs);

    const onAbort = () => {
      if (record.settled) return;
      this.cleanup(record, 'aborted');
      record.settle(null);
    };
    if (request.signal && typeof request.signal.addEventListener === 'function') {
      if (request.signal.aborted) onAbort();
      else request.signal.addEventListener('abort', onAbort, { once: true });
    }
    record.onAbort = onAbort;
    record.signal = request.signal || null;

    const result = await answer;
    clearTimeout(timer);
    if (record.signal && record.onAbort) {
      try {
        record.signal.removeEventListener('abort', record.onAbort);
      } catch {
        /* ignore */
      }
    }
    this.cleanup(record, 'done');

    if (!result) {
      this.stats.delegated += 1;
      return next();
    }
    // Validate before claiming: the host rejects a partial or unknown batch.
    if (!this.isCompleteAnswer(record, result)) {
      this.stats.delegated += 1;
      return next();
    }
    this.stats.answered += 1;
    return { answers: result.answers };
  }

  isCompleteAnswer(record, answer) {
    if (!answer || !Array.isArray(answer.answers)) return false;
    if (answer.answers.length !== record.questions.length) return false;
    const seen = new Set();
    for (const item of answer.answers) {
      if (!item || typeof item.id !== 'string') return false;
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      if (!Array.isArray(item.selected)) return false;
      if (item.selected.length === 0 && typeof item.custom !== 'string') return false;
    }
    return record.questions.every((question) => seen.has(question.id));
  }

  /** Answer a pending question batch from a phone. Returns false when unknown/expired. */
  answer(requestId, answers) {
    const record = this.pending.get(String(requestId));
    if (!record || record.settled) return false;
    const normalized = { answers: Array.isArray(answers) ? answers : [] };
    if (!this.isCompleteAnswer(record, normalized)) return false;
    record.settle(normalized);
    return true;
  }

  cleanup(record, reason) {
    this.pending.delete(record.requestId);
    if (reason !== 'done') {
      this.emit({ type: 'question-closed', data: { requestId: record.requestId, sessionId: record.sessionId, reason } });
    }
  }

  pendingFor(sessionId) {
    const result = [];
    for (const record of this.pending.values()) {
      if (record.sessionId !== String(sessionId)) continue;
      result.push({
        requestId: record.requestId,
        sessionId: record.sessionId,
        callId: record.callId,
        questions: record.questions,
        timeoutMs: this.timeoutMs,
        expiresAt: record.createdAt + this.timeoutMs,
      });
    }
    return result;
  }

  dispose() {
    this._disposed = true;
    if (this._handler && typeof this.ctx?.off === 'function') {
      try {
        this.ctx.off('user-questions/request', this._handler);
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
  }
}
