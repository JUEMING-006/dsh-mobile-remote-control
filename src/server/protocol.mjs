/**
 * DSH Remote Control - Host protocol normalization.
 *
 * Translates durable DSH session events / live stream frames into the stable
 * UI wire shape documented in .plan/SPEC.md section 4. The mobile client never
 * parses DSH event vocabulary.
 */

const TOOL_OUTPUT_MAX = 4000;
const SNIPPET_MAX = 160;

export function textOfBlocks(blocks) {
  if (!Array.isArray(blocks)) return '';
  return blocks
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
}

export function truncate(text, max) {
  if (typeof text !== 'string') return '';
  return text.length > max ? text.slice(0, max) + '…' : text;
}

/** Fresh per-session fold state used to turn events into UI messages. */
export function createMessageState() {
  return {
    messages: [],
    byId: new Map(),
    callIndex: new Map(),
    changes: [],
    todos: null,
    title: null,
    model: null,
    lastSeq: -1,
  };
}

export function resetMessageState(state) {
  state.messages.length = 0;
  state.byId.clear();
  state.callIndex.clear();
  state.changes.length = 0;
  state.todos = null;
  state.lastSeq = -1;
  return state;
}

function isAppendEvent(event) {
  const op = event && event.surfaceOp;
  return op === undefined || op === 'append';
}

function pushMessage(state, message) {
  state.messages.push(message);
  state.byId.set(message.id, message);
  state.lastSeq = Math.max(state.lastSeq, message.seq ?? -1);
  for (const block of message.blocks) {
    if (block.type === 'tool' && block.callId) state.callIndex.set(block.callId, { message, block });
  }
  return message;
}

function userMessageFromEvent(event) {
  const data = event.data || {};
  const content = Array.isArray(data.content) ? data.content : [];
  const blocks = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'text' && typeof part.text === 'string') {
      blocks.push({ type: 'text', text: part.text });
    } else if (part.type === 'image' && part.attachment) {
      blocks.push({
        type: 'image',
        attachmentId: part.attachment.attachmentId,
        mediaType: part.attachment.mediaType || 'image/png',
        width: part.attachment.width,
        height: part.attachment.height,
      });
    }
  }
  if (blocks.length === 0) return null;
  return {
    id: String(data.id || 'user-' + event.seq),
    seq: event.seq,
    role: 'user',
    time: event.time,
    blocks,
  };
}

function assistantMessageFromEvent(event) {
  const data = event.data || {};
  const message = data.message || {};
  const content = Array.isArray(message.content) ? message.content : [];
  const blocks = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'text' && typeof part.text === 'string') {
      blocks.push({ type: 'text', text: part.text });
    } else if (part.type === 'reasoning' && typeof part.text === 'string') {
      blocks.push({ type: 'reasoning', text: part.text });
    } else if (part.type === 'tool-call') {
      blocks.push({
        type: 'tool',
        callId: String(part.id || ''),
        name: String(part.name || 'tool'),
        args: typeof part.arguments === 'string' ? part.arguments : JSON.stringify(part.arguments ?? {}),
        status: 'running',
      });
    }
  }
  if (blocks.length === 0) return null;
  return {
    id: String(message.id || 'assistant-' + event.seq),
    seq: event.seq,
    role: 'assistant',
    time: event.time,
    turn: data.turn,
    step: data.step,
    blocks,
    ...(message.source && message.source.kind === 'model'
      ? { model: { provider: message.source.provider, model: message.source.model } }
      : {}),
    ...(data.usage ? { usage: data.usage } : {}),
  };
}

function applyToolResult(state, event) {
  const data = event.data || {};
  const resultMessage = data.message || {};
  // Current logs keep the call id on the result message; some writers also put
  // it on the event data root, and the tool source repeats it.
  const callId =
    resultMessage.toolCallId ||
    data.toolCallId ||
    (resultMessage.source && resultMessage.source.callId);
  if (!callId) return null;
  const found = state.callIndex.get(String(callId));
  if (!found) return null;
  const isError = resultMessage.isError === true;
  found.block.status = isError ? 'error' : 'done';
  found.block.isError = isError;
  found.block.output = truncate(textOfBlocks(resultMessage.content), TOOL_OUTPUT_MAX);
  return { kind: 'message-update', message: found.message };
}

/**
 * Apply one durable session event to the fold state.
 * @returns {Array<object>} zero or more UI events for subscribers.
 */
export function applyEvent(state, event, extra = {}) {
  if (!event || typeof event.type !== 'string') return [];
  switch (event.type) {
    case 'user/message': {
      const source = event.data && event.data.source;
      if (!source || source.kind !== 'user') return [];
      if (!isAppendEvent(event)) return [];
      const message = userMessageFromEvent(event);
      if (!message) return [];
      pushMessage(state, message);
      return [{ kind: 'message', message }];
    }
    case 'assistant/message': {
      if (!isAppendEvent(event)) return [];
      const message = assistantMessageFromEvent(event);
      if (!message) return [];
      pushMessage(state, message);
      return [{ kind: 'message', message }];
    }
    case 'tool/result': {
      const update = applyToolResult(state, event);
      return update ? [update] : [];
    }
    case 'session/title': {
      const title = event.data && event.data.title;
      if (typeof title !== 'string' || !title.trim()) return [];
      state.title = title;
      return [{ kind: 'title', title }];
    }
    case 'model/selection': {
      const data = event.data || {};
      if (!data.provider || !data.model) return [];
      state.model = { provider: data.provider, model: data.model, ...(data.reasoningEffort ? { reasoningEffort: data.reasoningEffort } : {}) };
      return [{ kind: 'model', selection: state.model }];
    }
    case 'turn/start': {
      return [{ kind: 'status', running: true, turn: event.data && event.data.turn, time: event.time }];
    }
    case 'turn/end': {
      const reason = event.data && event.data.reason;
      const error = reason && reason.kind === 'error' ? reason.error : undefined;
      return [
        { kind: 'status', running: false, turn: event.data && event.data.turn, time: event.time },
        {
          kind: 'turn-end',
          turn: event.data && event.data.turn,
          ok: !error,
          reasonKind: reason && reason.kind,
          time: event.time,
          ...(error ? { error } : {}),
        },
      ];
    }
    case 'workspace/changes': {
      const turn = event.data && event.data.turn;
      const summary = typeof extra.summaryFor === 'function' ? extra.summaryFor(event.seq) : null;
      const change = { kind: 'changes', seq: event.seq, turn, summary: summary || null };
      state.changes.push({ seq: event.seq, turn, summary: summary || null });
      return [change];
    }
    case 'deliverables/presented': {
      const files = (event.data && event.data.files) || [];
      if (!Array.isArray(files) || files.length === 0) return [];
      const normalized = files
        .filter((file) => file && typeof file.path === 'string')
        .map((file) => ({
          path: file.path,
          description: typeof file.description === 'string' ? file.description : '',
        }));
      if (normalized.length === 0) return [];
      state.deliverables = (state.deliverables || []).concat(normalized.map((file) => ({ ...file, turn: event.data && event.data.turn, seq: event.seq })));
      return [{ kind: 'deliverables', files: normalized, turn: event.data && event.data.turn, seq: event.seq }];
    }
    case 'todo/write': {
      const todos = (event.data && event.data.todos) || [];
      state.todos = todos;
      return [{ kind: 'todo', todos }];
    }
    default:
      return [];
  }
}

/** Normalize one agent assistant-stream frame into UI stream events. */
export function normalizeAssistantStreamFrame(frame) {
  if (!frame || typeof frame !== 'object') return [];
  if (frame.type === 'start') {
    return [{ kind: 'stream-start', attemptId: frame.attemptId, turn: frame.turn, step: frame.step }];
  }
  if (frame.type === 'chunk') {
    const chunk = frame.chunk || {};
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
      return [{ kind: 'stream', attemptId: frame.attemptId, block: 'text', text: chunk.text }];
    }
    if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') {
      return [{ kind: 'stream', attemptId: frame.attemptId, block: 'reasoning', text: chunk.text }];
    }
    return [];
  }
  return [];
}

/** Fold a page of durable records into messages without emitting UI events. */
export function foldRecords(state, records, extra = {}) {
  const events = [];
  for (const record of records || []) {
    if (!record || record.type !== 'event' || !record.event) continue;
    const produced = applyEvent(state, record.event, extra);
    for (const item of produced) events.push(item);
  }
  return events;
}

export function titleOf(summary) {
  const values = (summary && summary.projections && summary.projections.values) || {};
  const title = values.title;
  if (typeof title === 'string' && title.trim()) return title.trim();
  return summary && summary.blank ? '新任务' : '未命名任务';
}

export function modelSelectionOf(summary) {
  const values = (summary && summary.projections && summary.projections.values) || {};
  const selection = values.modelSelection;
  if (!selection) return null;
  const chosen = selection.next || selection.lastUsed;
  if (!chosen || !chosen.provider || !chosen.model) return null;
  return {
    provider: chosen.provider,
    model: chosen.model,
    ...(chosen.reasoningEffort ? { reasoningEffort: chosen.reasoningEffort } : {}),
  };
}

export function statsOf(summary) {
  const values = (summary && summary.projections && summary.projections.values) || {};
  const stats = values.sessionStats || {};
  return { turns: Number(stats.turns) || 0, steps: Number(stats.steps) || 0 };
}

export function basenameOfPath(path) {
  if (typeof path !== 'string' || !path) return '';
  const cleaned = path.replace(/[\\/]+$/, '');
  const parts = cleaned.split(/[\\/]/);
  return parts[parts.length - 1] || cleaned;
}

/** Pick a relative-time bucket label used by the task list grouping. */
export function timeBucket(timestamp, now = Date.now()) {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '更早';
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const todayMs = startOfToday.getTime();
  const dayMs = 24 * 60 * 60 * 1000;
  if (timestamp >= todayMs) return '今天';
  if (timestamp >= todayMs - dayMs) return '昨天';
  if (timestamp >= todayMs - 3 * dayMs) return '2 天前';
  if (timestamp >= todayMs - 7 * dayMs) return '上周';
  return '更早';
}

export function relativeTime(timestamp, now = Date.now()) {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '';
  const diff = Math.max(0, now - timestamp);
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return '刚刚';
  if (diff < hour) return Math.floor(diff / minute) + ' 分钟前';
  if (diff < day) return Math.floor(diff / hour) + ' 小时前';
  if (diff < 30 * day) return Math.floor(diff / day) + ' 天前';
  const date = new Date(timestamp);
  return date.getFullYear() + '/' + String(date.getMonth() + 1).padStart(2, '0') + '/' + String(date.getDate()).padStart(2, '0');
}

export function snippetOf(text) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  return truncate(normalized, SNIPPET_MAX);
}

/**
 * Expand the compact assistant-stream reconnect baseline into plain text.
 * The compact records are the same ones DSH stores on assistant/attempt events:
 * text-chunks/reasoning-chunks carry arrays of deltas, chunk records carry a
 * single raw chunk.
 */
export function expandAssistantStreamBaseline(assistantStream) {
  const result = { attemptId: null, turn: null, step: null, text: '', reasoning: '' };
  if (!assistantStream || !assistantStream.activeAttempt) return result;
  const attempt = assistantStream.activeAttempt;
  result.attemptId = attempt.attemptId || null;
  result.turn = attempt.turn;
  result.step = attempt.step;
  const records = Array.isArray(attempt.stream) ? attempt.stream : [];
  for (const record of records) {
    if (!record || typeof record !== 'object') continue;
    if (record.type === 'text-chunks' && Array.isArray(record.texts)) {
      result.text += record.texts.join('');
    } else if (record.type === 'reasoning-chunks' && Array.isArray(record.texts)) {
      result.reasoning += record.texts.join('');
    } else if (record.type === 'chunk' && record.chunk && typeof record.chunk.text === 'string') {
      if (record.chunk.type === 'text-delta') result.text += record.chunk.text;
      else if (record.chunk.type === 'reasoning-delta') result.reasoning += record.chunk.text;
    }
  }
  return result;
}
