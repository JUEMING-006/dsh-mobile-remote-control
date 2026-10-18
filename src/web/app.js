/**
 * app.js — DSH 移动端远程控制（原生 ESM，零外部依赖）
 *
 * 路由：
 *   #/                 任务列表（视图 A）
 *   #/chat/<sessionId> 会话（视图 B）
 *   #/models           模型设置（视图 C）
 *
 * 真实模式下所有数据来自 HTTP / WS；只有 URL 带 ?mock=1 时才动态加载
 * mock.js（开发自检）。Token 从 ?token= 读入后写入 localStorage，并从
 * 地址栏移除；请求使用 X-Remote-Token，WS 使用 ?token=。
 */

const TOKEN_KEY = 'dsh-remote-token';
const MOCK = new URLSearchParams(location.search).get('mock') === '1';
// 自检钩子：?offline=1 让网络层必定失败，用于验证离线缓存首屏。
const SIMULATE_OFFLINE = new URLSearchParams(location.search).get('offline') === '1';
const BACKOFF = [1000, 2000, 4000, 8000];
const GROUP_ORDER = ['今天', '昨天', '2 天前', '上周', '更早'];
const SESSION_TITLE_FALLBACK = '任务会话';

/* 微信内置浏览器自带顶栏（显示 document.title 与域名），页面里再画一条同样的
 * 标题栏就会重复。这里检测环境，微信下由 CSS 收起页内标题行，只保留返回/更多。 */
const IS_WECHAT = /MicroMessenger/i.test(navigator.userAgent || '');
if (IS_WECHAT) document.documentElement.classList.add('env-wechat');

/**
 * Clean a session title for display: DSH titles are often the first prompt, which
 * starts with a drive-letter path such as "D:\game_gobang\任务报告 对该任务".
 * Strip that prefix and collapse whitespace so the first line reads as a title.
 */
function sessionDisplayTitle(raw) {
  let title = String(raw === null || raw === undefined ? '' : raw).trim();
  if (!title) return '';
  const stripped = title.replace(/^[A-Za-z]:[\\/](?:[^\\/\r\n]+[\\/])*/u, '').trim();
  if (stripped) title = stripped;
  title = title.replace(/\s+/g, ' ').trim();
  return title;
}

/** Short title for the WeChat host bar (it truncates hard and shows the domain). */
function hostBarTitle(raw) {
  const title = sessionDisplayTitle(raw);
  if (!title) return '远程控制';
  if (!IS_WECHAT) return title;
  const chars = Array.from(title);
  if (chars.length <= 12) return title;
  return chars.slice(0, 12).join('') + '…';
}

const viewRoot = document.getElementById('view-root');
const sheetRoot = document.getElementById('sheet-root');
const toastRoot = document.getElementById('toast-root');
const bannerEl = document.getElementById('conn-banner');
const bannerTextEl = document.getElementById('conn-banner-text');
const appEl = document.getElementById('app');

/* ------------------------------------------------------------------ */
/* 1. 基础工具                                                         */
/* ------------------------------------------------------------------ */

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(value) {
  return String(value === null || value === undefined ? '' : value).replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

function pad2(value) {
  return value < 10 ? '0' + value : String(value);
}

function formatTime(ts) {
  const date = new Date(Number(ts) || Date.now());
  return date.getMonth() + 1 + '/' + date.getDate() + ' ' + pad2(date.getHours()) + ':' + pad2(date.getMinutes());
}

function calendarDays(ts) {
  const then = new Date(Number(ts) || 0);
  const now = new Date();
  const a = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const b = new Date(then.getFullYear(), then.getMonth(), then.getDate()).getTime();
  return Math.round((a - b) / 86400000);
}

function formatRelative(ts) {
  const value = Number(ts) || 0;
  if (!value) return '';
  const diff = Math.max(0, Date.now() - value);
  if (diff < 60 * 1000) return '刚刚';
  if (diff < 60 * 60 * 1000) return Math.floor(diff / 60000) + ' 分钟前';
  if (diff < 24 * 60 * 60 * 1000) return Math.floor(diff / 3600000) + ' 小时前';
  const days = calendarDays(value);
  if (days <= 0) return '今天';
  if (days === 1) return '昨天';
  if (days <= 14) return days + ' 天前';
  const date = new Date(value);
  const now = new Date();
  if (date.getFullYear() === now.getFullYear()) {
    return date.getMonth() + 1 + ' 月 ' + date.getDate() + ' 日';
  }
  return date.getFullYear() + ' 年 ' + (date.getMonth() + 1) + ' 月 ' + date.getDate() + ' 日';
}

function timeGroup(ts) {
  const days = calendarDays(ts);
  if (days <= 0) return '今天';
  if (days === 1) return '昨天';
  if (days <= 6) return '2 天前';
  if (days <= 13) return '上周';
  return '更早';
}

function isNearBottom(element, threshold) {
  if (!element) return true;
  const limit = threshold === undefined ? 100 : threshold;
  return element.scrollHeight - element.scrollTop - element.clientHeight < limit;
}

function elapsedSeconds(chat) {
  if (!chat || !chat.runningStartedAt) return 0;
  return Math.max(0, Math.round((Date.now() - chat.runningStartedAt) / 1000));
}

function sortMessages(list) {
  return list.slice().sort((a, b) => {
    const sa = typeof a.seq === 'number' ? a.seq : Number.MAX_SAFE_INTEGER;
    const sb = typeof b.seq === 'number' ? b.seq : Number.MAX_SAFE_INTEGER;
    if (sa !== sb) return sa - sb;
    return (a.time || 0) - (b.time || 0);
  });
}

function isLocalMessage(item) {
  return !!item && typeof item.id === 'string' && item.id.indexOf('local-') === 0;
}

function messageText(item) {
  if (!item || !Array.isArray(item.blocks)) return '';
  return item.blocks
    .filter((block) => block && block.type === 'text')
    .map((block) => block.text || '')
    .join('\n\n');
}

function computeCounts() {
  return {
    workspaces: (S.workspaces || []).length,
    sessions: (S.sessions || []).length,
    running: (S.sessions || []).filter((item) => item.running).length,
  };
}

function currentCounts() {
  return S.counts || computeCounts();
}

function countLine() {
  const counts = currentCounts();
  return counts.workspaces + ' 个工作区 · ' + counts.sessions + ' 个任务';
}

function findSession(sessionId) {
  return (S.sessions || []).find((item) => item.id === sessionId) || null;
}

function upsertSessionSummary(summary) {
  if (!summary || !summary.id) return;
  const index = S.sessions.findIndex((item) => item.id === summary.id);
  if (index >= 0) S.sessions[index] = Object.assign({}, S.sessions[index], summary);
  else S.sessions.unshift(summary);
}

function providerEntries() {
  const entries = [];
  const groups = (S.models && S.models.groups) || [];
  for (const group of groups) {
    entries.push({ id: group.id, name: group.name || group.id, kind: 'group', group });
  }
  const failures = (S.models && S.models.failures) || [];
  for (const failure of failures) {
    if (entries.some((item) => item.id === failure.id)) continue;
    entries.push({ id: failure.id, name: failure.name || failure.id, kind: 'failure', failure });
  }
  return entries;
}

function findProviderGroup(providerId) {
  const groups = (S.models && S.models.groups) || [];
  return groups.find((group) => group.id === providerId) || null;
}

function findModelDef(providerId, modelId) {
  const group = findProviderGroup(providerId);
  if (!group) return null;
  return (group.models || []).find((model) => model.id === modelId) || null;
}

function currentSelection() {
  if (S.chat && S.chat.model) return S.chat.model;
  if (S.models && S.models.default) return S.models.default;
  return null;
}

function modelDisplayName(selection) {
  if (!selection) return '模型';
  const def = findModelDef(selection.provider, selection.model);
  return (def && def.name) || selection.model || '模型';
}

function monogram(name) {
  const text = String(name || '?').trim();
  if (!text) return '?';
  const first = Array.from(text)[0];
  return /[a-z]/i.test(first) ? first.toUpperCase() : first;
}

function twoLetterMonogram(word) {
  const letters = String(word || '').replace(/[^a-z0-9]/gi, '').toUpperCase();
  if (!letters) return '?';
  if (letters.length === 1) return letters;
  const rest = letters.slice(1).split('');
  const consonant = rest.find((ch) => 'AEIOU'.indexOf(ch) < 0);
  return letters[0] + (consonant || rest[0]);
}

// provider 竖栏 monogram：deepseek-official -> DO，deepseek-account -> DA，
// fenno -> FN，min -> MN；中文 provider 取前两个字。
function providerMonogram(providerId, name) {
  const id = String(providerId || '').trim();
  const parts = id.split(/[-_.\s]+/).filter(Boolean);
  if (parts.length >= 2) {
    return ((Array.from(parts[0])[0] || '') + (Array.from(parts[1])[0] || '')).toUpperCase();
  }
  if (parts.length === 1) {
    if (/^[a-z0-9]+$/i.test(parts[0])) return twoLetterMonogram(parts[0]);
    return Array.from(parts[0]).slice(0, 2).join('');
  }
  const display = String(name || '?').trim();
  const chars = Array.from(display);
  if (!chars.length) return '?';
  if (/^[a-z]/i.test(chars[0])) return twoLetterMonogram(display);
  return chars.slice(0, 2).join('');
}

function providerName(providerId) {
  const entry = providerEntries().find((item) => item.id === providerId);
  return entry ? entry.name : providerId;
}

function parseHash() {
  const hash = String(location.hash || '').replace(/^#/, '');
  const segments = hash.split('/').filter(Boolean);
  if (segments[0] === 'chat' && segments[1]) {
    return { name: 'chat', sessionId: decodeURIComponent(segments[1]) };
  }
  if (segments[0] === 'models') return { name: 'models', sessionId: null };
  return { name: 'tasks', sessionId: null };
}

function navigate(hash) {
  if (location.hash === hash) {
    handleRoute();
    return;
  }
  location.hash = hash;
}

/* ------------------------------------------------------------------ */
/* 2. 内联 SVG 图标（stroke: currentColor，无 emoji）                  */
/* ------------------------------------------------------------------ */

const ICONS = {
  back: '<path d="M15 4.5 7.5 12l7.5 7.5"/>',
  chevronRight: '<path d="m9 4.5 7.5 7.5L9 19.5"/>',
  chevronDown: '<path d="m4.5 9 7.5 7.5L19.5 9"/>',
  more: '<circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.2"/><circle cx="12" cy="7.7" r="0.9" fill="currentColor" stroke="none"/>',
  search: '<circle cx="11" cy="11" r="6.3"/><path d="m15.7 15.7 4.3 4.3"/>',
  filter: '<path d="M4 7h16M7.5 12h9M10.5 17h3"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4.2v6h-6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  check: '<path d="m5 12.5 4.6 4.6L19 7.2"/>',
  checkCircle: '<circle cx="12" cy="12" r="8.5"/><path d="m8 12.4 2.8 2.8 5.2-5.4"/>',
  folder: '<path d="M3.5 7.4A1.9 1.9 0 0 1 5.4 5.5h3.4l2 2h7.8a1.9 1.9 0 0 1 1.9 1.9v6.7a1.9 1.9 0 0 1-1.9 1.9H5.4a1.9 1.9 0 0 1-1.9-1.9z"/>',
  sidebar: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.6"/><path d="M14.8 4.5v15"/>',
  send: '<path d="M12 19V5.5"/><path d="m5.8 11.2 6.2-5.7 6.2 5.7"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="1.8" fill="currentColor" stroke="none"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2.2"/><path d="M15.5 5.8V5a1.5 1.5 0 0 0-1.5-1.5H5A1.5 1.5 0 0 0 3.5 5v9A1.5 1.5 0 0 0 5 15.5h.8"/>',
  thumbUp: '<path d="M7.5 11.2v8.3H4.6v-8.3z"/><path d="M7.5 11.2 11.4 4.6a2 2 0 0 1 2.1 2v2.9h3.6a2 2 0 0 1 2 2.3l-1 5.1a2 2 0 0 1-2 1.6H7.5"/>',
  thumbDown: '<path d="M16.5 12.8V4.5h2.9v8.3z"/><path d="M16.5 12.8 12.6 19.4a2 2 0 0 1-2.1-2v-2.9H6.9a2 2 0 0 1-2-2.3l1-5.1a2 2 0 0 1 2-1.6h8.6"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.2v5l3.2 2"/>',
  alert: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.2v5.3"/><circle cx="12" cy="16.4" r="0.9" fill="currentColor" stroke="none"/>',
  file: '<path d="M6 3.8h7.2L18 8.6v11.6H6z"/><path d="M13.2 3.8v4.8H18"/>',
  terminal: '<rect x="3.5" y="4.8" width="17" height="14.4" rx="2.6"/><path d="m7.4 9.8 2.6 2.2-2.6 2.2"/><path d="M13 14.2h3.6"/>',
  camera: '<path d="M4 8.5h3.1l1.4-2.1h7L16.9 8.5H20v10.6H4z"/><circle cx="12" cy="13.7" r="3.5"/>',
  image: '<rect x="3.5" y="5" width="17" height="14" rx="2.6"/><circle cx="8.4" cy="9.8" r="1.4"/><path d="m5.6 17 4.9-4.5 3 2.6 2.3-2.1 3.2 3"/>',
  diffFile: '<rect x="4.5" y="4.5" width="15" height="15" rx="3"/><path d="M12 8.5v7M8.5 12h7"/>',
  spark: '<path d="M12 3.5v3M12 17.5v3M3.5 12h3M17.5 12h3M6 6l2.1 2.1M15.9 15.9 18 18M18 6l-2.1 2.1M8.1 15.9 6 18"/><circle cx="12" cy="12" r="2.6"/>',
  link: '<path d="M10.2 13.8a3.5 3.5 0 0 0 5 0l2.6-2.6a3.5 3.5 0 0 0-5-5l-1.3 1.3"/><path d="M13.8 10.2a3.5 3.5 0 0 0-5 0l-2.6 2.6a3.5 3.5 0 0 0 5 5l1.3-1.3"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 14.2a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.56V20a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1H4a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1.11 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H10a1.7 1.7 0 0 0 1-1.56V4a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V10a1.7 1.7 0 0 0 1.56 1H20a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1z"/>',
  shield: '<path d="M12 3 5 6.2v5.3c0 4.2 2.9 7.6 7 9.5 4.1-1.9 7-5.3 7-9.5V6.2z"/><path d="m9.2 12.2 2 2 3.6-3.9"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.3 9.2a2.8 2.8 0 0 1 5.4.9c0 1.9-2.7 2.8-2.7 2.8"/><path d="M12 17h.01"/>',
};

function svgIcon(name, className) {
  const paths = ICONS[name] || ICONS.info;
  const cls = className ? 'ico ' + className : 'ico';
  return '<svg class="' + cls + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths + '</svg>';
}

/* ------------------------------------------------------------------ */
/* 3. Markdown 子集（先转义再加标签，避免 XSS）                        */
/* ------------------------------------------------------------------ */

function inlineMarkdown(raw) {
  let text = escapeHtml(raw);
  const codes = [];
  text = text.replace(/`([^`]+)`/g, (match, code) => {
    codes.push(code);
    return '\u0000' + (codes.length - 1) + '\u0000';
  });
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  text = text.replace(/\u0000(\d+)\u0000/g, (match, index) => '<code>' + codes[Number(index)] + '</code>');
  return text;
}

function isBlockStart(line) {
  if (!line) return true;
  if (/^```/.test(line)) return true;
  if (/^#{1,6}\s+/.test(line)) return true;
  if (/^>\s?/.test(line)) return true;
  if (/^\s*([-*+])\s+/.test(line)) return true;
  if (/^\s*\d+[.)]\s+/.test(line)) return true;
  if (/^(---|___|\*\*\*)\s*$/.test(line)) return true;
  return false;
}

function renderMarkdown(source) {
  const text = String(source === null || source === undefined ? '' : source).replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  let html = '';
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (/^```/.test(line)) {
      const fence = line.match(/^```([\w+-]*)\s*$/);
      const lang = fence ? fence[1] : '';
      const buffer = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index])) {
        buffer.push(lines[index]);
        index += 1;
      }
      index += 1;
      html += '<pre><code' + (lang ? ' data-lang="' + escapeHtml(lang) + '"' : '') + '>' + escapeHtml(buffer.join('\n')) + '</code></pre>';
      continue;
    }

    if (!line.trim()) {
      index += 1;
      continue;
    }

    if (/^(---|___|\*\*\*)\s*$/.test(line)) {
      html += '<hr/>';
      index += 1;
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = Math.min(4, heading[1].length);
      html += '<h' + level + '>' + inlineMarkdown(heading[2].trim()) + '</h' + level + '>';
      index += 1;
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quoted = [];
      while (index < lines.length && /^>\s?/.test(lines[index])) {
        quoted.push(lines[index].replace(/^>\s?/, ''));
        index += 1;
      }
      html += '<blockquote>' + inlineMarkdown(quoted.join('\n')).replace(/\n/g, '<br/>') + '</blockquote>';
      continue;
    }

    if (line.indexOf('|') >= 0 && index + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[index + 1])) {
      const parseRow = (row) => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
      const header = parseRow(line);
      index += 2;
      const rows = [];
      while (index < lines.length && lines[index].indexOf('|') >= 0 && lines[index].trim()) {
        rows.push(parseRow(lines[index]));
        index += 1;
      }
      html += '<div class="table-wrap"><table><thead><tr>' + header.map((cell) => '<th>' + inlineMarkdown(cell) + '</th>').join('') + '</tr></thead><tbody>';
      for (const row of rows) {
        html += '<tr>' + row.map((cell) => '<td>' + inlineMarkdown(cell) + '</td>').join('') + '</tr>';
      }
      html += '</tbody></table></div>';
      continue;
    }

    if (/^\s*([-*+])\s+/.test(line)) {
      const items = [];
      while (index < lines.length && /^\s*([-*+])\s+/.test(lines[index])) {
        items.push(inlineMarkdown(lines[index].replace(/^\s*([-*+])\s+/, '')));
        index += 1;
      }
      html += '<ul>' + items.map((item) => '<li>' + item + '</li>').join('') + '</ul>';
      continue;
    }

    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items = [];
      while (index < lines.length && /^\s*\d+[.)]\s+/.test(lines[index])) {
        items.push(inlineMarkdown(lines[index].replace(/^\s*\d+[.)]\s+/, '')));
        index += 1;
      }
      html += '<ol>' + items.map((item) => '<li>' + item + '</li>').join('') + '</ol>';
      continue;
    }

    const paragraph = [];
    while (index < lines.length && lines[index].trim() && !isBlockStart(lines[index])) {
      paragraph.push(lines[index]);
      index += 1;
    }
    if (paragraph.length) {
      html += '<p>' + paragraph.map((item) => inlineMarkdown(item)).join('<br/>') + '</p>';
    } else {
      index += 1;
    }
  }

  return html;
}

/* ------------------------------------------------------------------ */
/* 3.1 敏感信息展示级脱敏                                                */
/* ------------------------------------------------------------------ */

// 用户消息 / 助手正文（含行内 code）中的常见密钥形式在展示时脱敏为
// 「前4…后4」（sk- 前缀保留 8 位，例如 sk-2cc9…ce6c）。原文仍保留在
// 内存中；复制统一使用脱敏后的文本，避免二次泄露。
const SECRET_MASK_HTML = '<span class="secret-mask" title="已隐藏敏感信息">';

function maskSecretValue(value) {
  const text = String(value === null || value === undefined ? '' : value);
  if (!text) return '';
  let head;
  if (/^sk-proj-/i.test(text)) head = text.slice(0, 8);
  else if (/^sk-/i.test(text)) head = text.slice(0, 7);
  else head = text.slice(0, 4);
  const tail = text.slice(-4);
  if (text.length <= head.length + tail.length) return text.slice(0, 1) + '…' + text.slice(-1);
  return head + '…' + tail;
}

function maskSecretText(text, makeReplacement) {
  let output = String(text === null || text === undefined ? '' : text);
  output = output.replace(/\bsk-[A-Za-z0-9_-]{12,}/g, (match) => makeReplacement(match));
  output = output.replace(
    /(\b(?:api[_-]?key|access[_-]?token|secret|password|passwd)\b\s*[:=]\s*["']?)([A-Za-z0-9_\-.]{12,})/gi,
    (match, prefix, secret) => prefix + makeReplacement(secret),
  );
  output = output.replace(
    /(\bBearer\s+)([A-Za-z0-9_\-.]{16,})/gi,
    (match, prefix, secret) => prefix + makeReplacement(secret),
  );
  // 32+ 位 hex/base64 只有在明确的 key/token 上下文里才替换，避免误伤普通代码。
  output = output.replace(
    /(\b(?:key|token|secret|credential|auth[_-]?token)\b\s*[:=]\s*["']?)([A-Fa-f0-9]{32,}|[A-Za-z0-9+/=]{32,})/gi,
    (match, prefix, secret) => prefix + makeReplacement(secret),
  );
  return output;
}

function maskSecretsPlain(text) {
  return maskSecretText(text, (secret) => maskSecretValue(secret));
}

function maskTextWithTokens(text, state) {
  return maskSecretText(text, (secret) => {
    const token = '\u0001S' + state.spans.length + '\u0002';
    state.spans.push({ token, display: maskSecretValue(secret) });
    return token;
  });
}

// 把 token 回填成带 title 的中性标记；token 若落在 HTML 属性里（如链接
// href）只回填纯文本展示值，避免把 span 塞进属性破坏标签，同时不泄露原文。
function applyMaskTokens(html, state) {
  if (!html || !state || !state.spans.length) return html || '';
  const spans = state.spans;
  const replaceInText = (segment) => {
    let output = segment;
    for (const span of spans) output = output.split(span.token).join(SECRET_MASK_HTML + escapeHtml(span.display) + '</span>');
    return output;
  };
  const replaceInTag = (segment) => {
    let output = segment;
    for (const span of spans) output = output.split(span.token).join(escapeHtml(span.display));
    return output;
  };
  return String(html).split(/(<[^>]*>)/).map((segment) => {
    if (!segment) return '';
    return segment.charAt(0) === '<' ? replaceInTag(segment) : replaceInText(segment);
  }).join('');
}

function maskSecretsHtml(text) {
  const state = { spans: [] };
  const masked = maskTextWithTokens(String(text === null || text === undefined ? '' : text), state);
  return applyMaskTokens(escapeHtml(masked), state);
}

/* ------------------------------------------------------------------ */
/* 4. 全局状态                                                         */
/* ------------------------------------------------------------------ */

const S = {
  account: null,
  plugins: null,
  token: '',
  mock: MOCK,
  auth: 'pending',
  ws: 'idle',
  wsWasOpen: false,
  boot: null,
  sessions: [],
  workspaces: [],
  counts: null,
  models: null,
  route: { name: 'tasks', sessionId: null },
  tasks: {
    loading: true,
    error: null,
    refreshing: false,
    refreshTimer: null,
    onlyRunning: false,
    searchOpen: false,
    query: '',
    searching: false,
    results: null,
    searchError: null,
    searchMode: 'content',
    searchTimer: null,
  },
  chat: null,
  settings: { selected: null, refreshing: false, returnHash: '#/' },
  ui: { sheet: null },
};

let net = null;
let socket = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
let chatOpenTimer = null;
let listRefreshTimer = null;
let runTimer = null;
let liveRenderTimer = null;
let lastLiveRender = 0;
let toastTimer = null;
let composerObserver = null;



/* ------------------------------------------------------------------ */
/* 离线缓存（LAN HTTP 下没有 Service Worker，用 localStorage 承担）     */
/*   - 目的：冷启动/断网时不再白屏，先渲染上次的任务列表与会话骨架      */
/*   - 只缓存「可公开重现」的列表与模型目录；不缓存消息正文、不缓存     */
/*     token 以外的任何凭证                                            */
/* ------------------------------------------------------------------ */

const CACHE_PREFIX = 'dsh-rc-cache:';
const CACHE_LIST_KEY = CACHE_PREFIX + 'list';
const CACHE_MODELS_KEY = CACHE_PREFIX + 'models';
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function cacheWrite(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify({ at: Date.now(), value }));
  } catch (error) {
    /* 配额满或隐私模式：缓存是可选项，失败不影响主流程 */
  }
}

function cacheRead(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.at !== 'number') return null;
    if (Date.now() - parsed.at > CACHE_TTL_MS) {
      localStorage.removeItem(key);
      return null;
    }
    return parsed.value;
  } catch (error) {
    return null;
  }
}

function cacheListSnapshot() {
  cacheWrite(CACHE_LIST_KEY, {
    workspaces: S.workspaces,
    sessions: S.sessions,
    counts: S.counts,
    at: Date.now(),
  });
}

function restoreListSnapshot() {
  const cached = cacheRead(CACHE_LIST_KEY);
  if (!cached || !Array.isArray(cached.sessions)) return false;
  S.workspaces = Array.isArray(cached.workspaces) ? cached.workspaces : [];
  S.sessions = cached.sessions;
  S.counts = cached.counts || computeCounts();
  S.tasks.loading = false;
  S.tasks.error = null;
  S.staleAt = cached.at || 0;
  return true;
}

function cacheModelsSnapshot() {
  if (S.models) cacheWrite(CACHE_MODELS_KEY, S.models);
}

function restoreModelsSnapshot() {
  const cached = cacheRead(CACHE_MODELS_KEY);
  if (cached && Array.isArray(cached.groups)) S.models = cached;
}

function makeChat(sessionId) {
  return {
    sessionId,
    loading: true,
    error: null,
    summary: null,
    model: null,
    running: false,
    runningStartedAt: 0,
    runningTurn: null,
    turns: {},
    messages: [],
    hasMore: false,
    oldestSeq: null,
    changes: {},
    unreadCount: 0,
    deliverables: [],
    diffs: {},
    expandedTools: new Set(),
    expandedReasoning: new Set(),
    expandedChanges: new Set(),
    expandedTurns: new Set(),
    expandedProcessGroups: new Set(),
    feedback: {},
    images: {},
    pending: new Map(),
    liveAttempt: null,
    lastError: null,
    draft: '',
    attachments: [],
    uploading: false,
    loadingOlder: false,
    stick: true,
    focusComposer: false,
  };
}

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_CHAT_IMAGES = 4;
const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

function newAttachmentId() {
  return 'local-img-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('读取图片失败'));
    reader.readAsDataURL(file);
  });
}

function imageSizeOf(dataUrl) {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth || 0, height: image.naturalHeight || 0 });
    image.onerror = () => resolve({ width: 0, height: 0 });
    image.src = dataUrl;
  });
}

class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = 'ApiError';
    this.status = status || 0;
    this.code = code || '';
  }
}

function isAuthError(error) {
  return error instanceof ApiError && (error.status === 401 || error.status === 403);
}

/* ------------------------------------------------------------------ */
/* 5. Token / 网络层                                                   */
/* ------------------------------------------------------------------ */

function readToken() {
  let stored = '';
  try {
    stored = localStorage.getItem(TOKEN_KEY) || '';
  } catch (error) {
    stored = '';
  }

  const url = new URL(location.href);
  const urlToken = url.searchParams.get('token') || '';
  if (urlToken) {
    stored = urlToken;
    try {
      localStorage.setItem(TOKEN_KEY, urlToken);
    } catch (error) {
      /* 隐私模式下忽略 */
    }
  }

  if (url.searchParams.has('token')) {
    url.searchParams.delete('token');
    const query = url.searchParams.toString();
    history.replaceState(null, '', url.pathname + (query ? '?' + query : '') + url.hash);
  }

  return stored;
}

function createRealNet(token) {
  return {
    mode: 'real',
    async request(path, options) {
      const opts = options || {};
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      const headers = { 'X-Remote-Token': token };
      if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
      try {
        const response = await fetch(path, {
          method: opts.method || 'GET',
          headers,
          body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
          signal: controller.signal,
          cache: 'no-store',
        });
        const text = await response.text();
        let data = null;
        if (text) {
          try {
            data = JSON.parse(text);
          } catch (error) {
            data = null;
          }
        }
        if (!response.ok) {
          const code = data && data.error ? String(data.error) : '';
          let message = '请求失败（' + response.status + '）';
          if (code === 'unauthorized') message = '连接凭证已失效';
          else if (code === 'stopped') message = '远程控制已停止';
          else if (code) message = code;
          throw new ApiError(message, response.status, code);
        }
        if (text && data === null) throw new ApiError('响应格式错误', response.status);
        return data;
      } catch (error) {
        if (error && error.name === 'AbortError') throw new ApiError('请求超时，请检查与电脑端的连接', 0);
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

function openRealSocket(handlers) {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = protocol + '//' + location.host + '/ws?token=' + encodeURIComponent(S.token);
  const ws = new WebSocket(url);
  ws.onopen = () => handlers.onOpen && handlers.onOpen();
  ws.onmessage = (event) => {
    let data = null;
    try {
      data = JSON.parse(event.data);
    } catch (error) {
      return;
    }
    if (data && typeof data === 'object') handlers.onMessage && handlers.onMessage(data);
  };
  ws.onclose = (event) => handlers.onClose && handlers.onClose(event.code, event.reason);
  ws.onerror = () => {};
  return {
    get readyState() {
      return ws.readyState;
    },
    send(payload) {
      if (ws.readyState === 1) ws.send(JSON.stringify(payload));
    },
    close() {
      try {
        ws.close();
      } catch (error) {
        /* ignore */
      }
    },
  };
}

function wrapSocket(raw) {
  return {
    raw,
    isOpen() {
      return !!raw && raw.readyState === 1;
    },
    send(payload) {
      try {
        raw.send(payload);
      } catch (error) {
        /* ignore */
      }
    },
    close() {
      try {
        raw.close();
      } catch (error) {
        /* ignore */
      }
    },
  };
}

function connectSocket() {
  if (!net) return;
  if (socket && socket.isOpen()) return;
  clearTimeout(reconnectTimer);
  setWsState('connecting');
  const handlers = {
    onOpen: handleSocketOpen,
    onMessage: handleSocketMessage,
    onClose: handleSocketClose,
  };
  try {
    socket = wrapSocket(S.mock ? net.connect(handlers) : openRealSocket(handlers));
  } catch (error) {
    handleSocketClose(0, '');
  }
}

function wsSend(payload) {
  if (!socket) return false;
  if (!socket.isOpen()) return false;
  socket.send(payload);
  return true;
}

function setWsState(state) {
  S.ws = state;
  if (state === 'open') {
    S.wsWasOpen = true;
    reconnectAttempts = 0;
  }
  updateBanner();
}

function updateBanner() {
  const offline = S.offline === true;
  const disconnected = S.ws === 'closed' || (S.ws === 'connecting' && S.wsWasOpen);
  const show = S.auth === 'ready' && (offline || disconnected);
  if (bannerEl) bannerEl.hidden = !show;
  if (appEl) appEl.classList.toggle('ws-down', !!show);
  if (!show || !bannerTextEl) return;
  if (offline) {
    bannerTextEl.textContent = S.staleAt ? '离线 · 显示 ' + formatRelative(S.staleAt) + '同步的内容' : '当前离线';
    return;
  }
  bannerTextEl.textContent = S.ws === 'closed' ? '连接已断开，正在重连…' : '正在重新连接…';
}

function scheduleListRefresh() {
  if (listRefreshTimer) return;
  listRefreshTimer = setTimeout(() => {
    listRefreshTimer = null;
    if (socket && socket.isOpen()) wsSend({ type: 'list' });
  }, 800);
}

function scheduleReconnect() {
  const delay = BACKOFF[Math.min(reconnectAttempts, BACKOFF.length - 1)];
  reconnectAttempts += 1;
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    if (S.auth === 'ready') connectSocket();
  }, delay);
}

function handleSocketClose(code) {
  socket = null;
  setWsState('closed');
  updateBanner();
  if (S.auth !== 'ready') return;
  if (code === 4001 || code === 4003) {
    S.auth = 'invalid';
    renderApp();
    return;
  }
  scheduleReconnect();
}

function handleSocketOpen() {
  setWsState('open');
  wsSend({ type: 'hello' });
  wsSend({ type: 'list' });
  const chat = S.chat;
  if (chat && S.route.name === 'chat') {
    wsSend({ type: 'open', sessionId: chat.sessionId });
    wsSend({ type: 'approval-pending', sessionId: chat.sessionId });
    wsSend({ type: 'question-pending', sessionId: chat.sessionId });
    wsSend({ type: 'usage', sessionId: chat.sessionId });
  }
  if (S.route.name === 'models') refreshModels(true);
}


/* ------------------------------------------------------------------ */
/* 审批（仅 ask 权限模式下出现；完全权限时 Host 不产生审批）            */
/* ------------------------------------------------------------------ */

let approvalSheetEl = null;
let approvalTimer = null;

function approvalCopy(toolName, reason) {
  const zh = String(reason || '').trim();
  return {
    title: '工具调用需要审批',
    tool: String(toolName || '工具'),
    detail: zh || '这次工具调用需要更高权限。',
  };
}

function showApprovalSheet(data) {
  if (!data || !data.requestId) return;
  closeApprovalSheet({ silent: true });
  const copy = approvalCopy(data.toolName, data.reason);
  const wrap = document.createElement('div');
  wrap.className = 'approval-backdrop';
  wrap.setAttribute('role', 'dialog');
  wrap.setAttribute('aria-modal', 'true');
  wrap.innerHTML =
    '<div class="approval-sheet">' +
      '<div class="approval-head">' + svgIcon('shield', 'approval-icon') + '<span>' + escapeHtml(copy.title) + '</span></div>' +
      '<div class="approval-tool">' + escapeHtml(copy.tool) + '</div>' +
      '<div class="approval-reason">' + escapeHtml(copy.detail) + '</div>' +
      '<div class="approval-countdown" data-role="countdown"></div>' +
      '<div class="approval-actions">' +
        '<button type="button" class="approval-btn reject" data-approval="reject">拒绝</button>' +
        '<button type="button" class="approval-btn allow" data-approval="allow">允许一次</button>' +
      '</div>' +
    '</div>';
  wrap.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-approval]');
    if (!btn) return;
    wsSend({ type: 'approval-answer', requestId: data.requestId, decision: btn.getAttribute('data-approval') });
    closeApprovalSheet({ silent: true });
  });
  document.body.appendChild(wrap);
  approvalSheetEl = wrap;
  const deadline = Number(data.expiresAt) || (Date.now() + (Number(data.timeoutMs) || 40000));
  const tick = () => {
    const el = wrap.querySelector('[data-role="countdown"]');
    const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    if (el) el.textContent = left > 0 ? left + ' 秒后自动交回电脑端' : '正在交回电脑端…';
    if (left <= 0) return;
    approvalTimer = setTimeout(tick, 500);
  };
  tick();
}

function closeApprovalSheet(data) {
  if (approvalTimer) { clearTimeout(approvalTimer); approvalTimer = null; }
  if (approvalSheetEl) { approvalSheetEl.remove(); approvalSheetEl = null; }
  if (data && data.reason === 'timeout') toast('审批超时，已交回电脑端处理');
}

function applyPendingApprovals(list) {
  if (Array.isArray(list) && list.length > 0) showApprovalSheet(list[0]);
  else closeApprovalSheet({ silent: true });
}



/* ------------------------------------------------------------------ */
/* 提问（ask_user_question）：必须一次答齐该批次的所有问题              */
/* ------------------------------------------------------------------ */

let questionSheetEl = null;
let questionTimer = null;
let questionState = null;

function questionSheetHtml(data) {
  const questions = Array.isArray(data.questions) ? data.questions : [];
  const blocks = questions.map((item, index) => {
    const options = (item.options || []).map((option) => {
      const value = escapeHtml(option.label);
      return '<label class="q-option">' +
        '<input type="' + (item.multiSelect ? 'checkbox' : 'radio') + '" name="q-' + escapeHtml(item.id) + '" value="' + value + '">' +
        '<span class="q-option-main"><span class="q-option-label">' + value + '</span>' +
        (option.description ? '<span class="q-option-desc">' + escapeHtml(option.description) + '</span>' : '') +
        '</span></label>';
    }).join('');
    const freeText = '<input class="q-custom" type="text" data-q-custom="' + escapeHtml(item.id) + '" placeholder="' +
      (item.options && item.options.length ? '或直接输入其他答案' : '输入你的回答') + '" autocomplete="off">';
    return '<div class="q-block" data-q-id="' + escapeHtml(item.id) + '">' +
      '<div class="q-title">' + escapeHtml(item.header || ('问题 ' + (index + 1))) + '</div>' +
      '<div class="q-text">' + escapeHtml(item.question) + '</div>' +
      (options ? '<div class="q-options">' + options + '</div>' : '') +
      freeText +
      '</div>';
  }).join('');
  return '<div class="question-sheet" role="dialog" aria-modal="true" aria-label="模型提问">' +
    '<div class="q-head">' + svgIcon('help', 'q-icon') + '<span>模型需要你的确认</span>' +
    '<button class="q-close" data-q-close aria-label="稍后回答">' + svgIcon('close', 'ico-sm') + '</button></div>' +
    blocks +
    '<div class="q-countdown" data-role="q-countdown"></div>' +
    '<div class="q-actions"><button class="q-submit" data-q-submit>提交回答</button></div>' +
    '</div>';
}

function showQuestionSheet(data) {
  if (!data || !data.requestId) return;
  closeQuestionSheet(true);
  questionState = { requestId: data.requestId, questions: data.questions || [], expiredAt: Number(data.expiresAt) || 0 };
  const wrap = document.createElement('div');
  wrap.className = 'question-backdrop';
  wrap.innerHTML = questionSheetHtml(data);
  wrap.addEventListener('click', (event) => {
    if (event.target.closest('[data-q-close]')) {
      closeQuestionSheet(true);
      toast('已收起，可在会话内重新打开');
      return;
    }
    if (event.target.closest('[data-q-submit]')) submitQuestionAnswer();
  });
  document.body.appendChild(wrap);
  questionSheetEl = wrap;
  const deadline = questionState.expiredAt || (Date.now() + (Number(data.timeoutMs) || 90000));
  const tick = () => {
    const el = wrap.querySelector('[data-role="q-countdown"]');
    const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    if (el) el.textContent = left > 0 ? left + ' 秒后自动交回电脑端' : '正在交回电脑端…';
    if (left > 0) questionTimer = setTimeout(tick, 500);
  };
  tick();
}

function closeQuestionSheet(silent) {
  if (questionTimer) { clearTimeout(questionTimer); questionTimer = null; }
  if (questionSheetEl) { questionSheetEl.remove(); questionSheetEl = null; }
  questionState = null;
  if (!silent) toast('提问已结束');
}

function submitQuestionAnswer() {
  const state = questionState;
  if (!state || !questionSheetEl) return;
  const answers = [];
  for (const item of state.questions) {
    const block = questionSheetEl.querySelector('[data-q-id="' + CSS.escape(item.id) + '"]');
    if (!block) return;
    const selected = [...block.querySelectorAll('input[type=radio]:checked, input[type=checkbox]:checked')].map((input) => input.value);
    const customInput = block.querySelector('[data-q-custom]');
    const custom = customInput ? customInput.value.trim() : '';
    if (selected.length === 0 && !custom) {
      toast('还有问题没有回答');
      block.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }
    answers.push({ id: item.id, selected, ...(custom ? { custom } : {}) });
  }
  wsSend({ type: 'question-answer', requestId: state.requestId, answers });
  closeQuestionSheet(true);
  toast('已提交回答');
}

function handleSocketMessage(message) {
  if (!message || typeof message !== 'object') return;
  switch (message.type) {
    case 'hello': {
      const data = message.data || {};
      if (Array.isArray(data.sessions) || Array.isArray(data.workspaces)) {
        applyBootstrap(data);
        if (S.route.name === 'tasks') refreshTasksView();
        if (S.route.name === 'models') renderSettings();
      }
      break;
    }
    case 'list':
      applyList(message.data);
      break;
    case 'opened':
      applyOpenedData(message.sessionId, message.data || {});
      break;
    case 'event':
      handleSessionEvent(message.sessionId, message.event || {});
      break;
    case 'models':
      if (message.data) {
        S.models = message.data;
        if (S.route.name === 'models') renderSettings();
        else if (S.route.name === 'chat') updateChatChrome();
      }
      break;
    case 'session-meta':
      applySessionMeta(message.data || {});
      break;
    case 'deliverables':
      if (S.chat && S.chat.sessionId === message.sessionId) {
        S.chat.deliverables = (S.chat.deliverables || []).concat(message.files || []).slice(-50);
        renderMessages();
      }
      break;
    case 'event':
      if (message.event && message.event.kind === 'deliverables' && S.chat) {
        S.chat.deliverables = (S.chat.deliverables || []).concat(message.event.files || []).slice(-50);
        renderMessages();
      }
      break;
    case 'usage':
      if (S.chat && S.chat.sessionId === message.sessionId) {
        S.chat.usage = message.data || null;
        renderUsageBar();
      }
      break;
    case 'account':
      S.account = message.data || null;
      if (S.route.name === 'models') renderSettings();
      break;
    case 'plugins':
      S.plugins = message.data || null;
      if (S.route.name === 'models') renderSettings();
      break;
    case 'approval-request':
      showApprovalSheet(message.data || {});
      break;
    case 'question-request':
      showQuestionSheet(message.data || {});
      break;
    case 'question-closed':
      closeQuestionSheet(true);
      break;
    case 'question-pending':
      if (Array.isArray(message.data) && message.data.length) showQuestionSheet(message.data[0]);
      else closeQuestionSheet(true);
      break;
    case 'approval-closed':
      closeApprovalSheet(message.data || {});
      break;
    case 'approval-pending':
      applyPendingApprovals(message.data || []);
      break;
    case 'ack':
      handleAck(message);
      break;
    case 'error':
      handleSocketError(message);
      break;
    case 'pong':
      break;
    default:
      break;
  }
}

function handleAck(message) {
  const chat = S.chat;
  if (!chat || !message.requestId || !chat.pending.has(message.requestId)) return;
  const entry = chat.pending.get(message.requestId);
  chat.pending.delete(message.requestId);
  const local = chat.messages.find((item) => item.id === entry.localId);
  if (local) local.pending = false;
  renderMessages();
}

function handleSocketError(message) {
  const chat = S.chat;
  if (chat && message.requestId && chat.pending.has(message.requestId)) {
    const entry = chat.pending.get(message.requestId);
    chat.pending.delete(message.requestId);
    const local = chat.messages.find((item) => item.id === entry.localId);
    if (local) {
      local.pending = false;
      local.failed = true;
    }
    chat.running = false;
    chat.runningStartedAt = 0;
    chat.liveAttempt = null;
    renderMessages();
    updateChatChrome();
    toast('发送失败：' + (message.message || '电脑端未接受这次请求'));
    return;
  }

  if (message.code === 'unauthorized') {
    handleAuthError(new ApiError('连接凭证已失效', 401, 'unauthorized'));
    return;
  }
  if (message.code === 'stopped') {
    handleAuthError(new ApiError('远程控制已停止', 403, 'stopped'));
    return;
  }
  if (message.code === 'session_not_found' || message.code === 'not_found') {
    if (chat) {
      chat.loading = false;
      chat.error = message.message || '会话不存在或已被删除';
      renderMessages();
      updateChatChrome();
    }
    return;
  }
  toast(message.message || '操作失败');
}

function applyBootstrap(data) {
  if (!data) return;
  S.boot = data;
  if (Array.isArray(data.workspaces)) S.workspaces = data.workspaces;
  if (Array.isArray(data.sessions)) S.sessions = data.sessions;
  S.counts = data.counts || computeCounts();
  if (data.models) S.models = data.models;
  if (data.defaultModel && !S.models) S.models = { groups: [], default: data.defaultModel, failures: [] };
  S.tasks.loading = false;
  S.tasks.error = null;
  if (S.auth !== 'ready' && S.auth !== 'invalid' && S.auth !== 'stopped' && S.auth !== 'missing') S.auth = 'ready';
  cacheListSnapshot();
  cacheModelsSnapshot();
}

function applyList(data) {
  if (!data) return;
  if (Array.isArray(data.workspaces)) S.workspaces = data.workspaces;
  if (Array.isArray(data.sessions)) S.sessions = data.sessions;
  S.counts = data.counts || computeCounts();
  S.boot = Object.assign({}, S.boot || {}, {
    counts: S.counts,
    workspaces: S.workspaces,
    sessions: S.sessions,
  });
  if (S.tasks.refreshing) {
    clearTimeout(S.tasks.refreshTimer);
    S.tasks.refreshing = false;
  }
  cacheListSnapshot();
  if (S.route.name === 'tasks') refreshTasksView();
  else if (S.route.name === 'models') renderSettings();
}

function applySessionMeta(data) {
  if (!data || !data.sessionId) return;
  const index = S.sessions.findIndex((item) => item.id === data.sessionId);

  const addedSummary = data.added && typeof data.added === 'object' ? data.added : null;

  if (data.removed) {
    S.sessions = S.sessions.filter((item) => item.id !== data.sessionId);
  } else if (addedSummary) {
    if (index >= 0) S.sessions[index] = Object.assign({}, S.sessions[index], addedSummary, { id: data.sessionId });
    else S.sessions.unshift(Object.assign({}, addedSummary, { id: data.sessionId }));
  } else if (index >= 0) {
    const next = Object.assign({}, S.sessions[index]);
    if (typeof data.running === 'boolean') next.running = data.running;
    if (data.title) next.title = data.title;
    if (data.updatedAt) next.updatedAt = data.updatedAt;
    if (data.model) next.model = data.model;
    S.sessions[index] = next;
  } else {
    scheduleListRefresh();
  }

  const chat = S.chat;
  if (chat && chat.sessionId === data.sessionId) {
    if (typeof data.running === 'boolean') {
      if (data.running) chat.runningStartedAt = chat.runningStartedAt || Date.now();
      else chat.runningStartedAt = 0;
      chat.running = data.running;
    }
    if (data.title) chat.summary = Object.assign({}, chat.summary || {}, { title: data.title });
    if (data.model) chat.model = data.model;
    if (S.route.name === 'chat') {
      updateChatChrome();
      if (typeof data.running === 'boolean') renderMessages();
    }
  }

  if (S.route.name === 'tasks') refreshTasksView();
}

/* ------------------------------------------------------------------ */
/* 6. 路由与顶层渲染                                                   */
/* ------------------------------------------------------------------ */

function renderApp() {
  if (S.auth === 'missing' || S.auth === 'invalid' || S.auth === 'stopped') {
    viewRoot.innerHTML = authPageHtml(S.auth);
    sheetRoot.innerHTML = '';
    document.title = IS_WECHAT ? '远程控制' : '远程控制';
    updateBanner();
    return;
  }

  if (S.auth !== 'ready') {
    viewRoot.innerHTML = tasksShellHtml();
    updateTasksContent();
    document.title = IS_WECHAT ? '远程控制' : '远程控制';
    updateBanner();
    return;
  }

  if (S.route.name === 'chat') renderChat();
  else if (S.route.name === 'models') renderSettings();
  else renderTasks();
  updateBanner();
}

function handleRoute() {
  const route = parseHash();
  const previous = S.route;
  S.route = route;

  if (S.auth !== 'ready') {
    renderApp();
    return;
  }

  if (route.name === 'chat') {
    openChat(route.sessionId);
    return;
  }

  clearTimeout(chatOpenTimer);
  if (previous.name === 'chat' && previous.sessionId && socket && socket.isOpen()) {
    wsSend({ type: 'close', sessionId: previous.sessionId });
  }

  if (route.name === 'models') {
    S.settings.returnHash = previous.name === 'chat' && previous.sessionId ? '#/chat/' + encodeURIComponent(previous.sessionId) : '#/';
    renderSettings();
    return;
  }

  renderTasks();
}

function handleAuthError(error) {
  const status = error instanceof ApiError ? error.status : 0;
  S.auth = status === 403 ? 'stopped' : 'invalid';
  clearTimeout(reconnectTimer);
  clearTimeout(chatOpenTimer);
  if (socket) {
    try {
      socket.close();
    } catch (error) {
      /* ignore */
    }
    socket = null;
  }
  setWsState('closed');
  S.ui.sheet = null;
  if (sheetRoot) sheetRoot.innerHTML = '';
  renderApp();
}

/* ------------------------------------------------------------------ */
/* 7. Toast / 剪贴板                                                   */
/* ------------------------------------------------------------------ */

function toast(message) {
  if (!toastRoot) return;
  toastRoot.innerHTML = '<div class="toast">' + escapeHtml(message) + '</div>';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastRoot.innerHTML = '';
  }, 1800);
}

async function copyText(text) {
  // 复制统一走脱敏文本：即使页面上有原文，也不把密钥写进剪贴板。
  const value = maskSecretsPlain(String(text === null || text === undefined ? '' : text));
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(value);
    } else {
      const helper = document.createElement('textarea');
      helper.value = value;
      helper.style.position = 'fixed';
      helper.style.opacity = '0';
      document.body.appendChild(helper);
      helper.select();
      document.execCommand('copy');
      helper.remove();
    }
    toast('已复制');
  } catch (error) {
    toast('复制失败，请手动选择文本');
  }
}

/* ------------------------------------------------------------------ */
/* 8. 视口 / 键盘适配                                                  */
/* ------------------------------------------------------------------ */

function initViewport() {
  const apply = () => {
    const viewport = window.visualViewport;
    const height = viewport ? viewport.height : window.innerHeight;
    document.documentElement.style.setProperty('--app-h', Math.round(height) + 'px');
    if (S.chat && S.route.name === 'chat' && S.chat.stick) {
      requestAnimationFrame(() => {
        const scroller = document.getElementById('chat-scroll');
        if (scroller) scroller.scrollTop = scroller.scrollHeight;
      });
    }
  };
  apply();
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', apply);
    window.visualViewport.addEventListener('scroll', apply);
  }
  window.addEventListener('orientationchange', () => setTimeout(apply, 250));
}


/* ------------------------------------------------------------------ */
/* 9. 视图 A：任务列表                                                 */
/* ------------------------------------------------------------------ */

function renderTasks() {
  viewRoot.innerHTML = tasksShellHtml();
  updateTasksContent();
  document.title = IS_WECHAT ? '远程控制' : '远程控制';
  updateBanner();
}

function tasksShellHtml() {
  return `<section class="view tasks-view">
  <div class="tasks-scroll">
    <header class="page-head">
      <div class="head-row">
        <div class="head-titles">
          <h1 class="head-title">远程控制</h1>
          <p class="head-sub">已连接到当前桌面窗口</p>
        </div>
        <div class="head-actions">
          <button class="icon-btn" data-action="new-task" aria-label="新建任务">${svgIcon('plus')}</button>
          <button class="icon-btn" data-action="conn-info" aria-label="连接信息">${svgIcon('info')}</button>
          <button class="icon-btn" data-action="toggle-search" aria-label="搜索任务">${svgIcon('search')}</button>
        </div>
      </div>
    </header>

    <div class="search-bar" id="search-bar"${S.tasks.searchOpen ? '' : ' hidden'}>
      <label class="search-field">
        ${svgIcon('search', 'ico-sm')}
        <input id="task-search-input" type="search" placeholder="搜索任务和会话" value="${escapeHtml(S.tasks.query)}" autocomplete="off" enterkeyhint="search" />
      </label>
      <button class="search-cancel" data-action="cancel-search">取消</button>
    </div>

    <div class="notice-card">本次连接可以查看当前设备上已打开的项目、任务和会话；手机端操作会实时同步到电脑。</div>

    <div class="section-head">
      <div class="section-titles">
        <h2 class="section-title">当前设备上的工作和任务</h2>
        <p class="section-count" id="tasks-count">${escapeHtml(countLine())}</p>
      </div>
      <div class="section-actions">
        <button class="icon-btn" data-action="open-filter-sheet" aria-label="筛选任务">${svgIcon('filter')}</button>
        <button class="icon-btn" id="refresh-tasks-btn" data-action="refresh-tasks" aria-label="刷新任务列表">${svgIcon('refresh')}</button>
      </div>
    </div>

    <div class="filter-chip-row" id="tasks-filter-row"${S.tasks.onlyRunning ? '' : ' hidden'}></div>
    <div id="tasks-content"></div>
  </div>
</section>`;
}

function refreshTasksView() {
  if (S.route.name !== 'tasks' || S.auth !== 'ready') return;
  if (!document.getElementById('tasks-content')) renderTasks();
  else updateTasksContent();
}

function updateTasksContent() {
  const countEl = document.getElementById('tasks-count');
  if (countEl) countEl.textContent = countLine();

  const filterRow = document.getElementById('tasks-filter-row');
  if (filterRow) {
    filterRow.hidden = !S.tasks.onlyRunning;
    filterRow.innerHTML = S.tasks.onlyRunning
      ? '<button class="filter-chip" data-action="clear-filter">仅进行中' + svgIcon('close', 'ico-xs') + '</button>'
      : '';
  }

  const content = document.getElementById('tasks-content');
  if (content) content.innerHTML = tasksContentHtml();

  const searchBar = document.getElementById('search-bar');
  if (searchBar) searchBar.hidden = !S.tasks.searchOpen;
  const searchInput = document.getElementById('task-search-input');
  if (searchInput && S.tasks.searchOpen && searchInput.value !== S.tasks.query) searchInput.value = S.tasks.query;

  updateTasksToolbar();
}

function updateTasksToolbar() {
  const btn = document.getElementById('refresh-tasks-btn');
  if (btn) btn.classList.toggle('spinning', !!S.tasks.refreshing);
}

function filteredSessions() {
  return (S.sessions || [])
    .filter((session) => !S.tasks.onlyRunning || session.running)
    .slice()
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

function tasksContentHtml() {
  if (S.tasks.searchOpen) return searchContentHtml();

  if (S.tasks.loading) return tasksSkeletonHtml();

  if (S.tasks.error) {
    return '<div class="state-box">' +
      svgIcon('alert', 'state-icon') +
      '<p class="state-title">加载失败</p>' +
      '<p class="state-text">' + escapeHtml(S.tasks.error) + '</p>' +
      '<button class="btn btn-primary" data-action="retry-bootstrap">重试</button>' +
      '</div>';
  }

  const sessions = filteredSessions();

  if (!sessions.length) {
    if (S.tasks.onlyRunning) {
      return '<div class="state-box">' +
        svgIcon('filter', 'state-icon') +
        '<p class="state-title">没有进行中的任务</p>' +
        '<p class="state-text">当前所有的远程任务都已经结束。</p>' +
        '<button class="btn" data-action="clear-filter">显示全部任务</button>' +
        '</div>';
    }
    return '<div class="state-box">' +
      svgIcon('folder', 'state-icon') +
      '<p class="state-title">还没有任务</p>' +
      '<p class="state-text">在电脑端开始一个任务，或使用右上角的「+」新建任务。</p>' +
      '<button class="btn btn-primary" data-action="new-task">新建任务</button>' +
      '</div>';
  }

  const buckets = new Map();
  for (const label of GROUP_ORDER) buckets.set(label, []);
  for (const session of sessions) {
    const label = timeGroup(session.updatedAt);
    if (!buckets.has(label)) buckets.set(label, []);
    buckets.get(label).push(session);
  }

  let html = '<div class="task-list">';
  for (const label of GROUP_ORDER) {
    const list = buckets.get(label) || [];
    if (!list.length) continue;
    html += '<section class="task-group"><h3 class="task-group-label">' + label + '</h3><div class="task-cards">';
    for (const session of list) html += taskCardHtml(session);
    html += '</div></section>';
  }
  html += '</div>';
  return html;
}

function taskCardHtml(session) {
  const title = maskSecretsPlain(session.title || (session.blank ? '新任务' : '(未命名任务)'));
  const workspaceTitle = maskSecretsPlain(session.workspaceTitle || '任务');
  const sub = workspaceTitle + ' · ' + formatRelative(session.updatedAt);
  return '<button class="task-card" data-action="open-session" data-id="' + escapeHtml(session.id) + '">' +
    '<div class="task-main">' +
    '<div class="task-title">' + escapeHtml(title) + '</div>' +
    '<div class="task-sub">' + escapeHtml(sub) + '</div>' +
    '</div>' +
    taskStatusHtml(session) +
    '</button>';
}

function taskStatusHtml(session) {
  if (session.running) return '<span class="pill pill-run"><span class="pill-dot"></span>进行中</span>';
  if (session.blank) return '<span class="pill-blank">未开始</span>';
  return '<span class="pill pill-done">' + svgIcon('check') + '已完成</span>';
}

function tasksSkeletonHtml() {
  let html = '<div class="task-list"><div class="sk-label"></div>';
  for (let i = 0; i < 6; i += 1) html += '<div class="sk sk-task"></div>';
  html += '</div>';
  return html;
}

function searchContentHtml() {
  if (S.tasks.searchError) {
    return '<div class="state-box">' +
      svgIcon('alert', 'state-icon') +
      '<p class="state-title">搜索失败</p>' +
      '<p class="state-text">' + escapeHtml(S.tasks.searchError) + '</p>' +
      '<button class="btn" data-action="retry-search">重试</button>' +
      '</div>';
  }

  const query = S.tasks.query.trim();

  if (!query) {
    return '<div class="state-box">' +
      svgIcon('search', 'state-icon') +
      '<p class="state-title">搜索任务和会话</p>' +
      '<p class="state-text">输入标题或工作区名称，查找电脑端的历史任务。</p>' +
      '</div>';
  }

  if (S.tasks.searching && !S.tasks.results) {
    return '<div class="load-older"><span class="spinner"></span>搜索中…</div>';
  }

  const items = S.tasks.results || [];
  if (!items.length) {
    return '<div class="state-box">' +
      svgIcon('search', 'state-icon') +
      '<p class="state-title">没有找到相关任务</p>' +
      '<p class="state-text">换个关键词试试，或取消搜索查看全部任务。</p>' +
      '<button class="btn" data-action="cancel-search">取消搜索</button>' +
      '</div>';
  }

  let html = '<div class="search-results">';
  if (S.tasks.searchMode === 'title') html += '<p class="search-mode-hint">当前 DSH 未开启全文检索，仅按标题/工作区匹配</p>';
  if (S.tasks.searching) html += '<div class="load-older"><span class="spinner"></span>搜索中…</div>';
  for (const item of items) {
    html += '<button class="search-result" data-action="open-session" data-id="' + escapeHtml(item.sessionId || '') + '">' +
      '<div class="search-result-title">' + escapeHtml(maskSecretsPlain(item.title || '(未命名任务)')) + '</div>' +
      '<div class="search-result-sub">' + escapeHtml(maskSecretsPlain(item.workspaceTitle || '任务')) + '</div>' +
      '<div class="search-result-snippet">' + escapeHtml(maskSecretsPlain(item.snippet || '')) + '</div>' +
      '</button>';
  }
  html += '</div>';
  return html;
}

/* ------------------------------------------------------------------ */
/* 10. 视图 B：会话                                                    */
/* ------------------------------------------------------------------ */

function renderChat() {
  const chat = S.chat;
  if (!chat) {
    viewRoot.innerHTML = '<div class="state-box">' + svgIcon('alert', 'state-icon') + '<p class="state-title">会话不可用</p><p class="state-text">请回到任务列表重新选择。</p><button class="btn btn-primary" data-action="chat-back">回到任务列表</button></div>';
    return;
  }

  viewRoot.innerHTML = chatShellHtml(chat);

  const textarea = document.getElementById('composer-input');
  if (textarea) {
    textarea.value = chat.draft || '';
    autoGrowComposer(textarea);
  }

  bindChatScroll();
  observeComposer();
  bindImageInputs();
  renderMessages();
  updateChatChrome();
  updateComposer();
  renderComposerAttachments();
  ensureRunTimer();
  document.title = hostBarTitle((chat.summary && chat.summary.title) || SESSION_TITLE_FALLBACK);

  if (chat.focusComposer) {
    chat.focusComposer = false;
    setTimeout(() => {
      const el = document.getElementById('composer-input');
      if (el) {
        try {
          el.focus();
        } catch (error) {
          /* ignore */
        }
      }
    }, 140);
  }
}



/* ------------------------------------------------------------------ */
/* 本轮交付物（来自 DSH 的 deliverables/presented 事件）                */
/* ------------------------------------------------------------------ */

function deliverablesCardHtml(files) {
  if (!Array.isArray(files) || files.length === 0) return '';
  const rows = files.map((file) => {
    const name = String(file.path || '').split(/[\\/]/).pop() || file.path;
    const desc = maskSecretsPlain(file.description || '');
    return '<li class="deliverable-row">' +
      '<span class="deliverable-icon">' + svgIcon('folder', 'ico-sm') + '</span>' +
      '<span class="deliverable-main"><span class="deliverable-name">' + escapeHtml(maskSecretsPlain(name)) + '</span>' +
      (desc ? '<span class="deliverable-desc">' + escapeHtml(desc) + '</span>' : '') + '</span>' +
      '</li>';
  }).join('');
  return '<div class="deliverables-card"><div class="deliverables-head">' +
    svgIcon('checkCircle', 'ico-sm') +
    '<span>本轮交付 ' + files.length + ' 个文件</span>' +
    '</div><ul class="deliverable-list">' + rows + '</ul>' +
    '<p class="deliverables-note">文件保存在电脑端工作区，手机端仅展示清单。</p></div>';
}

function chatShellHtml(chat) {
  const summary = chat.summary || {};
  const title = maskSecretsPlain(sessionDisplayTitle(summary.title || '') || SESSION_TITLE_FALLBACK);
  const workspaceTitle = maskSecretsPlain(summary.workspaceTitle || '任务');
  const isWechatEnv = IS_WECHAT;
  return `<section class="view chat-view">
  <header class="chat-nav">
    <button class="nav-btn" data-action="chat-back" aria-label="返回任务列表">${svgIcon('back')}</button>
    <div class="nav-title" data-workspace="${escapeHtml(workspaceTitle)}"><span>${escapeHtml(title)}</span></div>
    <button class="nav-btn" data-action="chat-menu" aria-label="更多操作">${svgIcon('more')}</button>
  </header>

  <div class="chat-toolbar">
    <button class="toolbar-ws" data-action="workspace-info">${svgIcon('folder')}<span>${escapeHtml(workspaceTitle)}</span></button>
    <button class="toolbar-new" data-action="chat-new-task">新建任务</button>
    <button class="toolbar-list" data-action="chat-to-list" aria-label="回到任务列表">${svgIcon('sidebar')}</button>
  </div>

  <div class="usage-slot"></div>

  <div class="chat-scroll" id="chat-scroll">
    <div class="load-older" id="load-older"></div>
    <div id="messages"></div>
  </div>

  <button class="jump-btn" id="jump-btn" data-action="jump-bottom" aria-label="回到底部">${svgIcon('chevronDown')}</button>

  <footer class="composer">
    <div class="composer-attachments" id="composer-attachments" hidden></div>
    <input type="file" id="image-camera-input" accept="image/png,image/jpeg,image/webp,image/gif" capture="environment" hidden />
    <input type="file" id="image-album-input" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden />
    <div class="composer-input">
      <textarea id="composer-input" rows="1" placeholder="提出后续修改要求" enterkeyhint="send" autocomplete="off" autocapitalize="off" spellcheck="false"></textarea>
    </div>
    <div class="composer-row">
      <button class="tool-btn" data-action="attach" aria-label="添加图片">${svgIcon('plus')}</button>
      <button class="model-pill" data-action="open-model-sheet">
        <span class="model-name">${escapeHtml(modelDisplayName(chat.model))}</span>
        ${svgIcon('chevronDown', 'ico-xs')}
      </button>
      <div class="composer-spacer"></div>
      <button class="send-btn" id="send-btn" data-action="send" aria-label="发送">${svgIcon('send')}</button>
    </div>
  </footer>
</section>`;
}

function bindChatScroll() {
  const scroller = document.getElementById('chat-scroll');
  if (!scroller) return;
  scroller.addEventListener('scroll', handleChatScroll, { passive: true });
}

function handleChatScroll() {
  const chat = S.chat;
  const scroller = document.getElementById('chat-scroll');
  if (!chat || !scroller) return;
  chat.stick = isNearBottom(scroller, 90);
  updateJumpButton();
  if (scroller.scrollTop < 60 && chat.hasMore && !chat.loadingOlder && !chat.loading) loadOlder();
}

function observeComposer() {
  const composer = document.querySelector('.composer');
  const view = document.querySelector('.chat-view');
  if (!composer || !view) return;
  if (composerObserver) {
    try {
      composerObserver.disconnect();
    } catch (error) {
      /* ignore */
    }
    composerObserver = null;
  }
  const apply = () => {
    view.style.setProperty('--composer-h', composer.offsetHeight + 'px');
  };
  apply();
  if (typeof ResizeObserver === 'function') {
    composerObserver = new ResizeObserver(apply);
    composerObserver.observe(composer);
  }
}

function bindImageInputs() {
  const camera = document.getElementById('image-camera-input');
  const album = document.getElementById('image-album-input');
  if (camera) camera.addEventListener('change', () => handleImageInput(camera));
  if (album) album.addEventListener('change', () => handleImageInput(album));
}

async function handleImageInput(input) {
  const chat = S.chat;
  const files = Array.from((input && input.files) || []);
  if (!chat || !files.length) return;
  for (const file of files) {
    if (chat.attachments.length >= MAX_CHAT_IMAGES) {
      toast('最多添加 ' + MAX_CHAT_IMAGES + ' 张图片');
      break;
    }
    if (!IMAGE_MEDIA_TYPES.includes(file.type)) {
      toast('仅支持 PNG / JPEG / WebP / GIF 图片');
      continue;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      toast('图片不能超过 10MB');
      continue;
    }
    let dataUrl = '';
    try {
      dataUrl = await readFileAsDataUrl(file);
    } catch (error) {
      toast('读取图片失败：' + (error.message || '未知错误'));
      continue;
    }
    const size = await imageSizeOf(dataUrl);
    chat.attachments.push({
      id: newAttachmentId(),
      name: file.name || '图片',
      mediaType: file.type,
      size: file.size,
      dataUrl,
      dataBase64: dataUrl.slice(dataUrl.indexOf(',') + 1),
      width: size.width,
      height: size.height,
    });
  }
  if (input) input.value = '';
  renderComposerAttachments();
  updateSendButton();
}

function renderComposerAttachments() {
  const container = document.getElementById('composer-attachments');
  if (!container) return;
  const chat = S.chat;
  const list = (chat && Array.isArray(chat.attachments)) ? chat.attachments : [];
  if (!list.length) {
    container.hidden = true;
    container.innerHTML = '';
    return;
  }
  container.hidden = false;
  container.innerHTML = list.map((attachment) =>
    '<div class="composer-attachment" data-att-id="' + escapeHtml(attachment.id) + '">' +
    '<img src="' + escapeHtml(attachment.dataUrl) + '" alt="待发送图片" />' +
    '<button type="button" class="att-remove" data-action="remove-attachment" data-att-id="' + escapeHtml(attachment.id) + '" aria-label="移除图片">' + svgIcon('close', 'ico-xs') + '</button>' +
    '</div>'
  ).join('');
  updateSendButton();
}

function removeAttachment(attachmentId) {
  const chat = S.chat;
  if (!chat) return;
  chat.attachments = chat.attachments.filter((item) => item.id !== attachmentId);
  renderComposerAttachments();
  updateSendButton();
}

function renderMessages(options) {
  const chat = S.chat;
  const container = document.getElementById('messages');
  if (!chat || !container) return;
  const opts = options || {};
  const scroller = document.getElementById('chat-scroll');
  const wasNearBottom = scroller ? isNearBottom(scroller, 120) : true;
  container.innerHTML = messagesHtml(chat);
  updateLoadOlder();
  if (scroller && !opts.keepScroll) {
    if (wasNearBottom || chat.stick) {
      scroller.scrollTop = scroller.scrollHeight;
      chat.stick = true;
    }
  }
  updateJumpButton();
  hydrateMessageImages();
  if (chat.running) ensureRunTimer();
}

// 把消息流归组成「用户消息 / assistant 回合块」：连续且 turn 相同的 assistant
// 消息（step 级）合并为一个回合块，一个回合只渲染一套页脚。
function buildChatItems(chat) {
  const items = [];
  let current = null;
  for (const message of chat.messages || []) {
    if (!message || !message.role) continue;
    if (message.role === 'assistant') {
      const turn = typeof message.turn === 'number' ? message.turn : null;
      if (current && turn !== null && current.turn === turn) {
        current.messages.push(message);
      } else {
        current = { kind: 'assistant-turn', turn, key: message.id, messages: [message] };
        items.push(current);
      }
    } else {
      current = null;
      items.push({ kind: 'user', message });
    }
  }
  return items;
}

function messagesHtml(chat) {
  if (chat.loading) return chatSkeletonHtml();

  if (chat.error) {
    return '<div class="state-box">' +
      svgIcon('alert', 'state-icon') +
      '<p class="state-title">无法打开会话</p>' +
      '<p class="state-text">' + escapeHtml(chat.error) + '</p>' +
      '<button class="btn" data-action="retry-chat">重试</button>' +
      '<button class="btn btn-primary" data-action="chat-back">回到任务列表</button>' +
      '</div>';
  }

  const messages = chat.messages || [];
  if (!messages.length && !chat.running) return emptyChatHtml(chat);

  const items = buildChatItems(chat);

  const parts = [];
  const renderedTurns = new Set();
  let errorRendered = false;

  items.forEach((item) => {
    if (item.kind === 'user') {
      parts.push(messageHtml(chat, item.message));
      return;
    }

    const group = item;
    const turn = group.turn;

    if (turn !== null && chat.changes[turn] && !renderedTurns.has(turn)) {
      renderedTurns.add(turn);
      parts.push(changesCardHtml(chat, chat.changes[turn]));
    }

    let errorInfo = null;
    if (!errorRendered && chat.lastError && turn !== null && chat.lastError.turn === turn) {
      errorRendered = true;
      errorInfo = chat.lastError;
    }

    const suppressFooter = group.messages.some((message) => message.live) ||
      (chat.running && typeof chat.runningTurn === 'number' && group.turn === chat.runningTurn);
    parts.push(assistantTurnHtml(chat, group, suppressFooter, errorInfo));
  });

  for (const key of Object.keys(chat.changes)) {
    const turn = Number(key);
    if (renderedTurns.has(turn)) continue;
    renderedTurns.add(turn);
    parts.push(changesCardHtml(chat, chat.changes[key]));
  }

  if (!errorRendered && chat.lastError) parts.push(turnErrorHtml(chat.lastError));
  if (Array.isArray(chat.deliverables) && chat.deliverables.length) parts.push(deliverablesCardHtml(chat.deliverables));
  if (chat.running) parts.push(runBarHtml(chat));

  return '<div class="messages">' + parts.join('') + '</div>';
}

function mergeTurnBlocks(messages) {
  const merged = [];
  let reasoningBlock = null;
  for (const message of messages || []) {
    for (const block of message.blocks || []) {
      if (!block || typeof block.type !== 'string') continue;
      if (block.type === 'reasoning') {
        const text = block.text || '';
        if (!reasoningBlock) {
          reasoningBlock = { type: 'reasoning', text, _mid: message.id };
          merged.push(reasoningBlock);
        } else if (text) {
          reasoningBlock.text = reasoningBlock.text ? reasoningBlock.text + '\n\n' + text : text;
        }
      } else {
        merged.push(Object.assign({}, block, { _mid: message.id }));
      }
    }
  }
  return merged;
}

function renderTurnBlocks(chat, group, blocks) {
  const live = group.messages.some((message) => message.live);
  const output = [];
  let textBuffer = [];

  const flushText = () => {
    if (!textBuffer.length) return;
    const state = { spans: [] };
    const maskedText = textBuffer.map((text) => maskTextWithTokens(text, state)).join('\n\n');
    const markdown = applyMaskTokens(renderMarkdown(maskedText), state);
    if (markdown) output.push('<div class="md">' + markdown + '</div>');
    textBuffer = [];
  };

  for (const block of blocks) {
    if (!block || typeof block.type !== 'string') continue;
    if (block.type === 'text') {
      textBuffer.push(block.text || '');
      continue;
    }
    flushText();
    if (block.type === 'reasoning') output.push(reasoningHtml(chat, group, block, live));
    else if (block.type === 'tool') output.push(toolHtml(chat, block._mid || group.key, block));
    else if (block.type === 'image') output.push(imageHtml(chat, block));
  }
  flushText();

  return output.join('');
}

function renderMaskedMarkdown(text) {
  const state = { spans: [] };
  const maskedText = maskTextWithTokens(String(text === null || text === undefined ? '' : text), state);
  return applyMaskTokens(renderMarkdown(maskedText), state);
}

const STEP_CATEGORY_LABELS = {
  thinking: '已完成分析',
  read: '已读取文件',
  readImage: '已读取图片',
  write: '已写入文件',
  search: '已搜索代码',
  edit: '修改了文件',
  commands: '执行了命令',
  code: '运行了代码',
  webSearch: '已搜索网页',
  webFetch: '已访问网页',
  subagents: '已协调子智能体',
  plan: '更新了计划',
  questions: '向用户提出了问题',
  tools: '已调用工具',
};

function toolCategoryKind(name) {
  const text = String(name === null || name === undefined ? '' : name).toLowerCase();
  if (text === 'read' || text === 'read_file' || text === 'readfile') return 'read';
  if (text === 'read_image' || text === 'readimage') return 'readImage';
  if (text === 'write' || text === 'write_file' || text === 'writefile') return 'write';
  if (text === 'grep' || text === 'glob' || text === 'search' || text === 'search_code') return 'search';
  if (text === 'edit' || text === 'str_replace') return 'edit';
  if (text === 'bash' || text === 'pwsh' || text === 'terminal' || text === 'exec') return 'commands';
  if (text === 'run_code' || text === 'code') return 'code';
  if (text === 'web_search' || text === 'websearch') return 'webSearch';
  if (text === 'web_fetch' || text === 'webfetch') return 'webFetch';
  if (text.indexOf('subagent') === 0) return 'subagents';
  if (text === 'todo_write' || text === 'todowrite') return 'plan';
  if (text === 'ask_user_question') return 'questions';
  return 'tools';
}

function formatTurnDuration(totalSeconds) {
  const total = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return hours + '时' + minutes + '分' + seconds + '秒';
  if (minutes > 0) return minutes + '分' + seconds + '秒';
  return seconds + '秒';
}

function normalizeTurnReason(reasonKind) {
  const kind = String(reasonKind === null || reasonKind === undefined ? '' : reasonKind).toLowerCase();
  if (kind === 'aborted' || kind === 'interrupted' || kind === 'cancelled' || kind === 'canceled' || kind === 'stopped') return 'aborted';
  if (kind === 'error' || kind === 'failed' || kind === 'failure') return 'failed';
  return 'normal';
}

function isGroupRunning(chat, group) {
  if (!group) return false;
  if (group.messages.some((message) => message.live)) return true;
  return !!(chat.running && typeof chat.runningTurn === 'number' && group.turn === chat.runningTurn);
}

function collectTurnProcess(group) {
  const messages = group.messages || [];
  const lastMessage = messages.length ? messages[messages.length - 1] : null;
  const items = [];
  const categories = [];
  let toolCount = 0;
  let hasReasoning = false;

  for (const message of messages) {
    const blocks = Array.isArray(message.blocks) ? message.blocks : [];
    blocks.forEach((block, blockIndex) => {
      if (!block || typeof block.type !== 'string') return;
      if (block.type === 'reasoning') {
        hasReasoning = true;
        items.push({ type: 'reasoning', block, message, blockIndex });
      } else if (block.type === 'tool') {
        toolCount += 1;
        const kind = toolCategoryKind(block.name);
        if (categories.indexOf(kind) < 0) categories.push(kind);
        items.push({ type: 'tool', block, message, blockIndex });
      } else if (block.type === 'text') {
        if (message !== lastMessage && String(block.text || '').trim()) items.push({ type: 'text', text: block.text, message });
      } else if (block.type === 'image') {
        items.push({ type: 'image', block, message });
      }
    });
  }

  // 工具类别优先按发生顺序参与标题；reasoning 作为额外类别放在最后，
  // 超过 3 类时会被「等」省略，与桌面端 closed group 的排名观感一致。
  if (hasReasoning) categories.push('thinking');
  const hasSteps = messages.some((message) => typeof message.step === 'number' && message.step > 1);
  return {
    items,
    categories,
    toolCount,
    hasReasoning,
    hasProcess: toolCount > 0 || hasReasoning || messages.length > 1 || hasSteps || items.length > 0,
    finalText: lastMessage ? messageText(lastMessage) : '',
    lastMessage,
  };
}

// 桌面 DSH 的 closed group 标题组合规则：最多 3 类，两类用「并」并去掉重复「已」，三类用「，」，超过三类加「等」。
function processGroupTitle(categories) {
  const labels = categories.slice(0, 3).map((kind) => STEP_CATEGORY_LABELS[kind] || STEP_CATEGORY_LABELS.tools);
  if (!labels.length) return STEP_CATEGORY_LABELS.thinking;
  if (labels.length === 1) return labels[0];
  if (labels.length === 2) {
    const second = labels[1];
    const secondTitle = labels[0].charAt(0) === '已' && second.charAt(0) === '已' ? second.slice(1) : second;
    return labels[0] + '并' + secondTitle;
  }
  let title = labels.join('，');
  if (categories.length > 3) title += '等';
  return title;
}

function turnFallbackStart(chat, group) {
  const first = group.messages.length ? group.messages[0] : null;
  const all = chat.messages || [];
  if (first) {
    const index = all.findIndex((message) => message.id === first.id);
    if (index > 0 && all[index - 1].role === 'user') return all[index - 1].time || first.time || 0;
  }
  return (first && first.time) || 0;
}

function turnMeta(chat, group) {
  if (isGroupRunning(chat, group)) return { running: true };

  const messages = group.messages || [];
  const first = messages.length ? messages[0] : null;
  const last = messages.length ? messages[messages.length - 1] : null;
  const info = group.turn !== null && chat.turns ? chat.turns[group.turn] : null;
  const preciseTiming = !!(info && typeof info.startedAt === 'number' && typeof info.endedAt === 'number');
  const startedAt = info && typeof info.startedAt === 'number' ? info.startedAt : turnFallbackStart(chat, group);
  const endedAt = info && typeof info.endedAt === 'number' ? info.endedAt : (last && last.time) || startedAt;
  let seconds = Math.floor((endedAt - startedAt) / 1000);
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  // Match the desktop client: every finished turn reports at least one second.
  if (seconds < 1) seconds = 1;

  let reason = normalizeTurnReason(info && info.reasonKind);
  if (reason === 'normal' && chat.lastError && chat.lastError.turn === group.turn) reason = 'failed';

  const processInfo = collectTurnProcess(group);
  const pageCutFallback =
    !preciseTiming &&
    chat.hasMore === true &&
    first !== null &&
    Array.isArray(chat.messages) &&
    chat.messages.length > 0 &&
    chat.messages[0] &&
    chat.messages[0].id === first.id;
  const label = reason === 'aborted'
    ? '已停止'
    : reason === 'failed'
      ? '处理失败'
      : startedAt && endedAt && !pageCutFallback
        ? '已完成，用时 ' + formatTurnDuration(seconds)
        : '已完成';
  const key = group.turn !== null ? 'turn:' + group.turn : 'group:' + group.key;
  const forcedOpen = reason === 'aborted' || reason === 'failed';
  const foldable = reason === 'normal' && processInfo.hasProcess;
  const expanded = forcedOpen || (foldable && chat.expandedTurns.has(key));

  return { running: false, key, reason, label, process: processInfo, forcedOpen, foldable, expanded, seconds, startedAt, endedAt, preciseTiming };
}

function turnProcessRowHtml(chat, group, meta) {
  if (meta.foldable) {
    return '<button type="button" class="turn-process-row" data-action="toggle-turn-process" data-turn-key="' + escapeHtml(meta.key) + '" aria-expanded="' + (meta.expanded ? 'true' : 'false') + '">' +
      '<span class="turn-process-label">' + escapeHtml(meta.label) + '</span>' +
      svgIcon('chevronDown', 'turn-process-chevron') +
      '</button>';
  }
  return '<div class="turn-process-row is-static"><span class="turn-process-label">' + escapeHtml(meta.label) + '</span></div>';
}

function processItemsHtml(chat, group, meta) {
  const output = [];
  for (const item of meta.process.items) {
    if (item.type === 'reasoning') {
      const key = group.key + ':p:' + item.message.id + ':r:' + item.blockIndex;
      const expanded = chat.expandedReasoning.has(key);
      output.push('<button class="fold-row" data-action="toggle-reasoning" data-key="' + escapeHtml(key) + '" aria-expanded="' + (expanded ? 'true' : 'false') + '">' +
        svgIcon('spark', 'ico-sm') +
        '<span>思考过程</span>' +
        svgIcon('chevronRight', 'chev') +
        '</button>');
      if (expanded) output.push('<div class="reasoning-body">' + maskSecretsHtml(item.block.text || '') + '</div>');
    } else if (item.type === 'text') {
      const html = renderMaskedMarkdown(item.text || '');
      if (html) output.push('<div class="process-commentary md">' + html + '</div>');
    } else if (item.type === 'tool') {
      output.push(toolHtml(chat, item.message.id, item.block));
    } else if (item.type === 'image') {
      output.push(imageHtml(chat, item.block));
    }
  }
  return output.join('');
}

function processGroupHtml(chat, group, meta) {
  const groupKey = group.key + ':process';
  const open = chat.expandedProcessGroups.has(groupKey);
  const title = processGroupTitle(meta.process.categories);
  let html = '<div class="process-group"><button type="button" class="process-group-row" data-action="toggle-process-group" data-group-key="' + escapeHtml(groupKey) + '" aria-expanded="' + (open ? 'true' : 'false') + '">' +
    svgIcon(open ? 'chevronDown' : 'chevronRight', 'process-group-chevron') +
    '<span class="process-group-label">' + escapeHtml(title) + '</span>' +
    '</button>';
  if (open) html += '<div class="process-group-body">' + processItemsHtml(chat, group, meta) + '</div>';
  html += '</div>';
  return html;
}

function finalAnswerHtml(chat, group) {
  const messages = group.messages || [];
  const last = messages.length ? messages[messages.length - 1] : null;
  const text = last ? messageText(last) : '';
  if (!text.trim()) return '';
  const html = renderMaskedMarkdown(text);
  if (!html) return '';
  return '<div class="md turn-final-answer">' + html + '</div>';
}

// 一个 assistant 回合：
// - running：保持流式展开显示 + 运行条（没有折叠行）；
// - ended：折叠行（已完成/已停止/处理失败）+ 可折叠的 process group + 最终回答 + 唯一页脚。
function assistantTurnHtml(chat, group, suppressFooter, errorInfo) {
  const live = group.messages.some((message) => message.live);
  const meta = turnMeta(chat, group);
  const error = errorInfo ? turnErrorHtml(errorInfo) : '';
  const footer = suppressFooter ? '' : turnActionsHtml(chat, group);
  const running = !!meta.running;

  let body;
  if (running) {
    body = renderTurnBlocks(chat, group, mergeTurnBlocks(group.messages));
  } else {
    body = turnProcessRowHtml(chat, group, meta) +
      (meta.expanded && meta.process.hasProcess ? processGroupHtml(chat, group, meta) : '') +
      finalAnswerHtml(chat, group);
  }

  return '<div class="msg msg-assistant turn-block' + (live || running ? ' is-live' : '') + '" data-group="' + escapeHtml(group.key) + '" data-turn="' + (group.turn === null ? '' : group.turn) + '">' +
    body + error + footer +
    '</div>';
}

function chatSkeletonHtml() {
  let html = '<div class="messages">';
  for (let index = 0; index < 3; index += 1) {
    const height = index === 0 ? 54 : 76;
    const margin = index === 0 ? 14 : 22;
    html += '<div class="sk" style="height:' + height + 'px;margin-top:' + margin + 'px;border-radius:12px"></div>';
  }
  html += '</div>';
  return html;
}

function emptyChatHtml(chat) {
  const blank = !!(chat.summary && chat.summary.blank);
  const title = blank ? '新任务已创建' : '还没有消息';
  const text = blank
    ? '输入你的需求开始对话，手机端发送后会实时同步到电脑端。'
    : '这个会话还没有消息，在下方输入第一条指令';
  return '<div class="state-box">' +
    svgIcon('terminal', 'state-icon') +
    '<p class="state-title">' + title + '</p>' +
    '<p class="state-text">' + text + '</p>' +
    '</div>';
}

function messageHtml(chat, message) {
  if (!message || message.role !== 'user') return '';
  const failed = message.failed
    ? '<div class="msg-fail">发送失败，<button class="btn btn-sm" data-action="retry-message" data-mid="' + escapeHtml(message.id) + '">重发</button></div>'
    : '';
  const blocks = Array.isArray(message.blocks) ? message.blocks : [];
  const images = blocks.filter((block) => block && block.type === 'image');
  const imageHtmlPart = images.length
    ? '<div class="msg-images">' + images.map((block) => imageHtml(chat, block)).join('') + '</div>'
    : '';
  const text = messageText(message);
  const textHtml = text ? '<div class="msg-user-text">' + maskSecretsHtml(text) + '</div>' : '';
  return '<div class="msg msg-user' + (message.pending ? ' msg-pending' : '') + '" data-mid="' + escapeHtml(message.id) + '">' +
    imageHtmlPart + textHtml + failed +
    '</div>';
}

function reasoningHtml(chat, group, block, live) {
  const key = group.key + ':reasoning';
  const expanded = chat.expandedReasoning.has(key);
  let elapsed = '';
  if (live && chat.runningStartedAt) {
    const seconds = Math.max(1, Math.round((Date.now() - chat.runningStartedAt) / 1000));
    elapsed = '<span class="fold-time">· ' + seconds + ' 秒</span>';
  }
  return '<button class="fold-row" data-action="toggle-reasoning" data-key="' + escapeHtml(key) + '" aria-expanded="' + (expanded ? 'true' : 'false') + '">' +
    svgIcon('spark', 'ico-sm') +
    '<span>思考过程</span>' + elapsed +
    svgIcon('chevronRight', 'chev') +
    '</button>' +
    (expanded ? '<div class="reasoning-body">' + maskSecretsHtml(block.text || '') + '</div>' : '');
}

function prettyArguments(args) {
  if (args === undefined || args === null) return '';
  if (typeof args === 'object') {
    try {
      return JSON.stringify(args, null, 2);
    } catch (error) {
      return String(args);
    }
  }
  const text = String(args);
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch (error) {
    return text;
  }
}

function toolHtml(chat, messageId, block) {
  const callId = block.callId || block.name || 'tool';
  const key = messageId + ':t:' + callId;
  const expanded = chat.expandedTools.has(key);
  const status = block.status === 'running' || block.status === 'error' ? block.status : 'done';
  const statusText = status === 'running' ? '运行中' : status === 'error' ? '失败' : '完成';
  const spinner = status === 'running' ? '<span class="spinner"></span>' : '';
  const output = block.output === undefined || block.output === null ? '' : String(block.output);
  const detail = expanded
    ? '<div class="tool-detail">' +
      '<div class="tool-label">参数</div><pre>' + escapeHtml(prettyArguments(block.args)) + '</pre>' +
      (output ? '<div class="tool-label">结果</div><pre>' + escapeHtml(output) + '</pre>' : '') +
      '</div>'
    : '';
  return '<div class="tool-card"><button class="tool-head" data-action="toggle-tool" data-key="' + escapeHtml(key) + '" aria-expanded="' + (expanded ? 'true' : 'false') + '">' +
    svgIcon('terminal') +
    '<span class="tool-name">' + escapeHtml(block.name || 'tool') + '</span>' +
    '<span class="tool-status ' + status + '">' + spinner + statusText + '</span>' +
    svgIcon('chevronRight', 'chev') +
    '</button>' + detail + '</div>';
}

function imageHtml(chat, block) {
  if (block.previewUrl) {
    return '<img class="msg-image" src="' + escapeHtml(block.previewUrl) + '" alt="图片附件" />';
  }
  const attachmentId = block.attachmentId || (block.attachment && block.attachment.attachmentId);
  if (!attachmentId) return '';
  block = Object.assign({}, block, { attachmentId: String(attachmentId) });
  const cached = chat.images[attachmentId];
  if (cached && cached.dataUrl) {
    return '<img class="msg-image" src="' + escapeHtml(cached.dataUrl) + '" alt="图片附件" loading="lazy" />';
  }
  if (cached && (cached.status === 'error' || (cached.status === 'done' && !cached.dataUrl))) {
    return '<div class="msg-image-slot">图片附件无法加载</div>';
  }
  return '<div class="msg-image-slot" data-attachment-id="' + escapeHtml(attachmentId) + '">' + svgIcon('file', 'ico-sm') + '图片附件加载中…</div>';
}

// /attachment/:id 返回 JSON {attachment, dataUrl}，需要取 dataUrl 再渲染图片。
function hydrateMessageImages() {
  const chat = S.chat;
  if (!chat) return;
  const nodes = document.querySelectorAll('[data-attachment-id]');
  for (const node of nodes) {
    const attachmentId = node.getAttribute('data-attachment-id');
    if (!attachmentId) continue;
    const cached = chat.images[attachmentId];
    if (cached) {
      if (cached.dataUrl) node.outerHTML = '<img class="msg-image" src="' + escapeHtml(cached.dataUrl) + '" alt="图片附件" loading="lazy" />';
      continue;
    }
    chat.images[attachmentId] = { status: 'loading' };
    net.request('/api/sessions/' + encodeURIComponent(chat.sessionId) + '/attachment/' + encodeURIComponent(attachmentId))
      .then((data) => {
        chat.images[attachmentId] = { status: 'done', dataUrl: data && data.dataUrl ? data.dataUrl : '' };
      })
      .catch(() => {
        chat.images[attachmentId] = { status: 'error' };
      })
      .finally(() => {
        if (S.chat === chat) renderMessages({ keepScroll: true });
      });
  }
}

// 回合页脚：复制本回合全部 text blocks、赞/踩（本地）、重试上一条 user 文本、最后一条消息时间。
function turnActionsHtml(chat, group) {
  const last = group.messages[group.messages.length - 1] || {};
  const key = escapeHtml(group.key);
  const vote = chat.feedback['turn:' + group.key] || '';
  return '<div class="msg-actions">' +
    '<button class="msg-action" data-action="copy-turn" data-group="' + key + '" aria-label="复制本回合内容">' + svgIcon('copy') + '</button>' +
    '<button class="msg-action' + (vote === 'up' ? ' on' : '') + '" data-action="feedback-turn" data-group="' + key + '" data-vote="up" aria-label="赞">' + svgIcon('thumbUp') + '</button>' +
    '<button class="msg-action' + (vote === 'down' ? ' on' : '') + '" data-action="feedback-turn" data-group="' + key + '" data-vote="down" aria-label="踩">' + svgIcon('thumbDown') + '</button>' +
    '<button class="msg-action" data-action="retry-turn" data-group="' + key + '" aria-label="重试上一条消息">' + svgIcon('refresh') + '</button>' +
    '<span class="msg-time">' + escapeHtml(formatTime(last.time)) + '</span>' +
    '</div>';
}

// 根据回合块首个消息 id 还原回合（供页脚操作使用）。
function findTurnGroup(chat, groupKey) {
  const messages = chat.messages || [];
  const index = messages.findIndex((message) => message.id === groupKey);
  if (index < 0) return null;
  const anchor = messages[index];
  if (anchor.role !== 'assistant') return null;
  const turn = typeof anchor.turn === 'number' ? anchor.turn : null;
  const group = { kind: 'assistant-turn', turn, key: anchor.id, messages: [anchor] };
  for (let cursor = index + 1; cursor < messages.length; cursor += 1) {
    const next = messages[cursor];
    if (next.role !== 'assistant') break;
    const nextTurn = typeof next.turn === 'number' ? next.turn : null;
    if (nextTurn !== turn) break;
    group.messages.push(next);
  }
  return group;
}

function turnText(group) {
  const parts = [];
  for (const message of group.messages || []) {
    for (const block of message.blocks || []) {
      if (block && block.type === 'text' && block.text) parts.push(block.text);
    }
  }
  return parts.join('\n\n');
}

function changesCardHtml(chat, entry) {
  const summary = entry.summary || {};
  const turn = typeof summary.turn === 'number' ? summary.turn : entry.turn;
  const files = Array.isArray(summary.files) ? summary.files : [];
  let added = 0;
  let deleted = 0;
  for (const file of files) {
    added += Number(file.added) || 0;
    deleted += Number(file.deleted) || 0;
  }
  if (typeof summary.added === 'number') added = summary.added;
  if (typeof summary.deleted === 'number') deleted = summary.deleted;
  const total = typeof summary.total === 'number' ? summary.total : files.length;

  const rows = [];
  files.forEach((file, index) => {
    const key = turn + ':' + index;
    const expanded = chat.expandedChanges.has(key);
    rows.push('<button class="change-file" data-action="toggle-change-file" data-turn="' + turn + '" data-index="' + index + '" data-seq="' + (entry.seq === undefined || entry.seq === null ? '' : entry.seq) + '" aria-expanded="' + (expanded ? 'true' : 'false') + '">' +
      '<span class="change-file-path">' + escapeHtml(file.display || file.path || '') + '</span>' +
      '<span class="change-file-stats">' +
      (file.added ? '<span class="stat-add">+' + file.added + '</span>' : '') +
      (file.deleted ? '<span class="stat-del">-' + file.deleted + '</span>' : '') +
      '</span>' +
      svgIcon('chevronRight', 'chev') +
      '</button>');
    if (expanded) rows.push(diffHtml(chat, entry.seq, index));
  });

  return '<div class="changes-card">' +
    '<div class="changes-head"><span class="changes-title">本轮改动 ' + total + ' 个文件</span>' +
    '<span class="changes-pill">' + svgIcon('diffFile') + '<span class="add">+' + added + '</span><span class="del">-' + deleted + '</span></span></div>' +
    rows.join('') +
    '</div>';
}

function diffHtml(chat, seq, index) {
  const key = seq + ':' + index;
  const diff = chat.diffs[key];
  if (diff === 'loading') return '<div class="diff-loading">正在加载 diff…</div>';
  if (diff === 'error') return '<div class="diff-loading">diff 加载失败，请稍后重试。</div>';
  if (!diff) return '<div class="diff-note">该轮改动详情已不可用（Host 重启后只保留当轮内存记录）。</div>';
  if (diff.kind && diff.kind !== 'text') {
    return '<div class="diff-note">' + (diff.kind === 'binary' ? '二进制文件，不展示 diff。' : '文件过大，已跳过 diff。') + '</div>';
  }
  const hunks = Array.isArray(diff.hunks) ? diff.hunks : [];
  if (!hunks.length) return '<div class="diff-note">没有文本差异。</div>';

  let html = '<div class="diff-view">';
  for (const hunk of hunks) {
    html += '<div class="diff-hunk-label">@@ -' + hunk.oldStart + ',' + hunk.oldLines + ' +' + hunk.newStart + ',' + hunk.newLines + ' @@</div>';
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    const lines = Array.isArray(hunk.lines) ? hunk.lines : [];
    for (const raw of lines) {
      const marker = raw.charAt(0);
      const text = raw.slice(1);
      let cls = 'ctx';
      let lineNo = newLine;
      if (marker === '+') {
        cls = 'add';
        lineNo = newLine;
        newLine += 1;
      } else if (marker === '-') {
        cls = 'del';
        lineNo = oldLine;
        oldLine += 1;
      } else {
        cls = 'ctx';
        lineNo = newLine;
        newLine += 1;
        oldLine += 1;
      }
      html += '<div class="diff-line ' + cls + '"><span class="ln">' + lineNo + '</span><span class="mark">' + (marker === '+' || marker === '-' ? marker : ' ') + '</span><span class="code">' + escapeHtml(text) + '</span></div>';
    }
  }
  html += '</div>';
  return html;
}

function lastRunningToolName(chat) {
  const messages = chat.messages || [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const blocks = messages[index].blocks || [];
    for (let blockIndex = blocks.length - 1; blockIndex >= 0; blockIndex -= 1) {
      const block = blocks[blockIndex];
      if (block && block.type === 'tool' && block.status === 'running') return block.name || '';
    }
  }
  return '';
}

function runBarHtml(chat) {
  const toolName = lastRunningToolName(chat);
  return '<div class="run-bar"><span class="spinner blue"></span><span>正在运行' +
    (toolName ? ' · <span class="run-tool">' + escapeHtml(toolName) + '</span>' : '') +
    '</span><span class="run-elapsed" id="run-elapsed">' + elapsedSeconds(chat) + 's</span></div>';
}

function turnErrorHtml(errorInfo) {
  return '<div class="turn-error">' + svgIcon('alert') + '<div><strong>本轮执行失败</strong><div>' + escapeHtml(errorInfo.message || '电脑端返回了错误') + '</div></div></div>';
}


/* ------------------------------------------------------------------ */
/* 会话用量（token 统计与上下文占用，来自 Host 的 token-meter 投影）    */
/* ------------------------------------------------------------------ */

function formatTokens(n) {
  const value = Number(n) || 0;
  if (value < 1000) return String(value);
  if (value < 1e6) return (value / 1000).toFixed(value < 10000 ? 1 : 0) + 'K';
  return (value / 1e6).toFixed(1) + 'M';
}

function usageBarHtml(usage) {
  if (!usage || (!usage.tokens && !usage.context)) return '';
  const tokens = usage.tokens || {};
  const context = usage.context || {};
  const total = Number(tokens.total) || 0;
  const cache = Number(tokens.cacheRead) || 0;
  const hitRate = total > 0 ? Math.round((cache / total) * 100) : 0;
  let pct = 0;
  if (context.contextWindow > 0) pct = Math.min(100, Math.round(((context.pressureTokens || context.surfaceTokens || 0) / context.contextWindow) * 100));
  return '<div class="usage-bar" role="group" aria-label="会话用量">' +
    '<span class="usage-item"><span class="usage-k">输入</span>' + formatTokens(tokens.input) + '</span>' +
    '<span class="usage-sep"></span>' +
    '<span class="usage-item"><span class="usage-k">输出</span>' + formatTokens(tokens.output) + '</span>' +
    (hitRate > 0 ? '<span class="usage-sep"></span><span class="usage-item"><span class="usage-k">缓存</span>' + hitRate + '%</span>' : '') +
    (context.contextWindow > 0
      ? '<span class="usage-spacer"></span><span class="usage-ctx" title="上下文占用 ' + formatTokens(context.pressureTokens || context.surfaceTokens) + ' / ' + formatTokens(context.contextWindow) + '">' +
        '<span class="usage-ring" style="--pct:' + pct + '"></span>' + pct + '%</span>'
      : '') +
    '</div>';
}

function renderUsageBar() {
  const chat = S.chat;
  const slot = document.querySelector('.usage-slot');
  if (!slot || !chat) return;
  slot.innerHTML = chat.usage ? usageBarHtml(chat.usage) : '';
}

function updateChatChrome() {
  const chat = S.chat;
  if (!chat) return;
  if (S.route.name === 'chat') {
    const titleEl = document.querySelector('.chat-nav .nav-title');
    const title = maskSecretsPlain(sessionDisplayTitle((chat.summary && chat.summary.title) || '') || SESSION_TITLE_FALLBACK);
    if (titleEl) {
      // Keep the inner <span> intact: in WeChat the row shows the workspace via
      // data-workspace and the span is hidden by CSS, so textContent would drop it.
      const span = titleEl.querySelector('span');
      if (span) span.textContent = title;
      else titleEl.textContent = title;
      titleEl.setAttribute('data-workspace', maskSecretsPlain((chat.summary && chat.summary.workspaceTitle) || '任务'));
    }
    const wsEl = document.querySelector('.toolbar-ws span');
    if (wsEl) wsEl.textContent = maskSecretsPlain((chat.summary && chat.summary.workspaceTitle) || '任务');
    document.title = hostBarTitle((chat.summary && chat.summary.title) || SESSION_TITLE_FALLBACK);
  }
  const modelEl = document.querySelector('.model-pill .model-name');
  if (modelEl) modelEl.textContent = modelDisplayName(chat.model);
  updateSendButton();
  ensureRunTimer();
  renderUsageBar();
}

function updateSendButton() {
  const chat = S.chat;
  const button = document.getElementById('send-btn');
  if (!chat || !button) return;
  const running = !!chat.running;
  const uploading = !!chat.uploading;
  button.classList.toggle('stopping', running);
  button.classList.toggle('uploading', uploading && !running);
  button.innerHTML = running ? svgIcon('stop') : uploading && !running ? '<span class="spinner"></span>' : svgIcon('send');
  button.setAttribute('aria-label', running ? '停止运行' : uploading ? '正在上传图片' : '发送');
  button.disabled = uploading && !running ? true : !running && !String(chat.draft || '').trim() && !(Array.isArray(chat.attachments) && chat.attachments.length);
}

function updateComposer() {
  const chat = S.chat;
  if (!chat) return;
  const textarea = document.getElementById('composer-input');
  if (textarea && textarea.value !== (chat.draft || '')) {
    textarea.value = chat.draft || '';
    autoGrowComposer(textarea);
  }
  updateSendButton();
}

function autoGrowComposer(textarea) {
  if (!textarea) return;
  const styles = window.getComputedStyle(textarea);
  const lineHeight = parseFloat(styles.lineHeight) || 25.5;
  const maxHeight = Math.round(lineHeight * 5 + 10);
  textarea.style.height = 'auto';
  textarea.style.height = Math.min(textarea.scrollHeight, maxHeight) + 'px';
  textarea.style.overflowY = textarea.scrollHeight > maxHeight ? 'auto' : 'hidden';
}

function ensureRunTimer() {
  const chat = S.chat;
  if (!chat || !chat.running) {
    clearInterval(runTimer);
    runTimer = null;
    return;
  }
  if (runTimer) return;
  runTimer = setInterval(() => {
    const current = S.chat;
    if (!current || !current.running) return;
    const elapsedEl = document.getElementById('run-elapsed');
    if (elapsedEl) elapsedEl.textContent = elapsedSeconds(current) + 's';
    updateSendButton();
  }, 1000);
}

function updateLoadOlder() {
  const chat = S.chat;
  const el = document.getElementById('load-older');
  if (!chat || !el) return;
  if (chat.loadingOlder) {
    el.innerHTML = '<span class="spinner"></span>正在加载更早消息…';
    return;
  }
  if (chat.loading) {
    el.innerHTML = '';
    return;
  }
  if (chat.hasMore) {
    el.innerHTML = '上滑加载更早消息';
    return;
  }
  el.innerHTML = (chat.messages || []).length ? '没有更早的消息了' : '';
}

function updateJumpButton() {
  const button = document.getElementById('jump-btn');
  const chat = S.chat;
  if (!button || !chat) return;
  const show = !chat.loading && (chat.messages || []).length > 3 && !chat.stick;
  const unread = show ? Number(chat.unreadCount) || 0 : 0;
  button.classList.toggle('show', show);
  button.classList.toggle('has-unread', unread > 0);
  button.innerHTML = unread > 0
    ? svgIcon('chevronDown') + '<span class="jump-count">' + (unread > 99 ? '99+' : unread) + '</span>'
    : svgIcon('chevronDown');
  button.setAttribute('aria-label', unread > 0 ? '回到底部，' + unread + ' 条新消息' : '回到底部');
}

function scrollToBottom() {
  const scroller = document.getElementById('chat-scroll');
  if (!scroller) return;
  scroller.scrollTop = scroller.scrollHeight;
  if (S.chat) {
    S.chat.stick = true;
    S.chat.unreadCount = 0;
  }
  updateJumpButton();
}

/* ------------------------------------------------------------------ */
/* 11. 视图 C：模型设置                                                */
/* ------------------------------------------------------------------ */

function renderSettings() {
  viewRoot.innerHTML = settingsShellHtml();
  document.title = '模型设置';
  updateBanner();
  if (!S.models && net && !S.settings.refreshing) void refreshModels(true);
  if (net) {
    if (!S.account) wsSend({ type: 'account' });
    if (!S.plugins) wsSend({ type: 'plugins' });
  }
}

function selectedProviderId() {
  const entries = providerEntries();
  if (!entries.length) return null;
  if (S.settings.selected && entries.some((entry) => entry.id === S.settings.selected)) return S.settings.selected;
  const current = currentSelection();
  if (current && entries.some((entry) => entry.id === current.provider)) return current.provider;
  if (S.models && S.models.default && entries.some((entry) => entry.id === S.models.default.provider)) return S.models.default.provider;
  return entries[0].id;
}


/* ------------------------------------------------------------------ */
/* 账户余额与插件清单（真实数据；未登录/不可用时如实说明）              */
/* ------------------------------------------------------------------ */

function formatMoney(amount, currency) {
  const symbol = currency === 'USD' ? '$' : '\u00A5';
  const value = Number(amount);
  if (!Number.isFinite(value)) return symbol + String(amount || '0');
  if (value === 0) return symbol + '0.00';
  if (value > 0 && value < 0.01) return '<' + symbol + '0.01';
  return symbol + value.toFixed(2);
}

function accountSectionHtml() {
  const account = S.account;
  const refresh = '<button class="icon-btn plain" data-action="refresh-account" aria-label="刷新余额">' + svgIcon('refresh') + '</button>';
  let body;
  if (!account) {
    body = '<div class="acct-loading"><span class="spinner"></span><span>正在读取账户…</span></div>';
  } else if (account.available === false) {
    body = '<p class="acct-note">当前 DSH 未提供账户服务。</p>';
  } else if (!account.signedIn) {
    body = '<p class="acct-note">未登录 DeepSeek 账号。请在电脑端 DSH「设置 → 账户」登录后刷新。</p>';
  } else if (account.status !== 'ready' || !Array.isArray(account.balance) || account.balance.length === 0) {
    body = '<p class="acct-note">余额读取失败，请稍后重试。</p>';
  } else {
    body = account.balance.map((w) => '<div class="acct-wallet"><span class="acct-amount">' + escapeHtml(formatMoney(w.balance, w.currency)) + '</span><span class="acct-currency">' + escapeHtml(w.currency) + '</span></div>').join('');
    const bonus = (account.bonusWallets || []).filter((w) => Number(w.balance) > 0).map((w) => '<div class="acct-bonus">赠送 ' + escapeHtml(formatMoney(w.balance, w.currency)) + '</div>').join('');
    body += bonus;
  }
  return '<section class="settings-section"><div class="settings-section-head"><h2>账户</h2>' + refresh + '</div>' + body + '</section>';
}

function pluginsSectionHtml() {
  const plugins = S.plugins;
  const refresh = '<button class="icon-btn plain" data-action="refresh-plugins" aria-label="刷新插件清单">' + svgIcon('refresh') + '</button>';
  let body;
  if (!plugins) {
    body = '<div class="acct-loading"><span class="spinner"></span><span>正在读取插件…</span></div>';
  } else if (plugins.available === false) {
    body = '<p class="acct-note">当前 DSH 未提供插件清单服务。</p>';
  } else if (!plugins.entries || plugins.entries.length === 0) {
    body = '<p class="acct-note">没有已加载的插件。</p>';
  } else {
    const enabled = plugins.entries.filter((e) => e.enabled).length;
    body = '<p class="acct-note">已加载 ' + plugins.entries.length + ' 个插件（启用 ' + enabled + ' 个，只读）。</p><ul class="plugin-list">' +
      plugins.entries.map((e) => {
        const name = maskSecretsPlain(e.title || e.moduleName || '未命名插件');
        const badge = e.enabled ? '<span class="plugin-state on">启用</span>' : '<span class="plugin-state off">停用</span>';
        const self = e.isRemoteControl ? '<span class="plugin-self">本插件</span>' : '';
        return '<li class="plugin-row"><span class="plugin-name">' + escapeHtml(name) + self + '</span>' + badge + '</li>';
      }).join('') + '</ul>';
  }
  return '<section class="settings-section"><div class="settings-section-head"><h2>插件</h2>' + refresh + '</div>' + body + '</section>';
}

function settingsShellHtml() {
  return `<section class="view settings-view">
  <div class="settings-scroll">
    <header class="settings-head">
      <div class="settings-nav">
        <button class="icon-btn" data-action="settings-back" aria-label="返回">${svgIcon('back')}</button>
        <button class="icon-btn plain${S.settings.refreshing ? ' spinning' : ''}" data-action="refresh-models" aria-label="刷新模型目录">${svgIcon('refresh')}</button>
      </div>
      <h1 class="settings-title">模型设置</h1>
      <p class="settings-sub">管理自定义模型供应商，配置后可在聊天时选择使用。</p>
    </header>

    <div class="settings-layout">
      ${providerRailHtml()}
      ${providerPaneHtml()}
    </div>

    ${accountSectionHtml()}
    ${pluginsSectionHtml()}

    <p class="settings-note">模型来自当前 DSH 配置；选择后会立即用于当前会话，并保存为默认。${S.chat && S.chat.summary && S.chat.summary.title ? ' 当前会话：' + escapeHtml(maskSecretsPlain(S.chat.summary.title)) + '。' : ''}</p>
  </div>
</section>`;
}

function providerRailHtml() {
  const entries = providerEntries();
  if (!entries.length) return '<nav class="provider-rail"></nav>';
  const selected = selectedProviderId();
  let html = '<nav class="provider-rail">';
  for (const entry of entries) {
    const on = entry.id === selected;
    html += '<button class="provider-chip' + (on ? ' on' : '') + (entry.kind === 'failure' ? ' err' : '') + '" data-action="select-provider" data-id="' + escapeHtml(entry.id) + '" aria-label="' + escapeHtml(entry.name) + '" aria-pressed="' + (on ? 'true' : 'false') + '">' +
      '<span class="mono">' + escapeHtml(providerMonogram(entry.id, entry.name)) + '</span>' +
      '<span class="dot"></span>' +
      '</button>';
  }
  html += '</nav>';
  return html;
}

function providerPaneHtml() {
  if (!S.models || !Array.isArray(S.models.groups)) {
    return '<div class="provider-pane"><div class="state-box"><span class="spinner"></span><p class="state-text" style="margin-top:14px">正在读取模型配置…</p></div></div>';
  }

  const entries = providerEntries();
  if (!entries.length) {
    return '<div class="provider-pane"><div class="state-box">' +
      svgIcon('alert', 'state-icon') +
      '<p class="state-title">没有可用的模型</p>' +
      '<p class="state-text">请先在电脑端 DSH 中配置模型供应商。</p>' +
      '<button class="btn" data-action="refresh-models">重新读取</button>' +
      '</div></div>';
  }

  const selectedId = selectedProviderId();
  const entry = entries.find((item) => item.id === selectedId) || entries[0];

  if (entry.kind === 'failure') {
    const failure = entry.failure || {};
    return '<div class="provider-pane"><div class="failure-card">' +
      '<div class="failure-title">' + svgIcon('alert', 'ico-sm') + escapeHtml(entry.name) + '</div>' +
      '<div class="failure-msg">' + escapeHtml(failure.message || '该供应商未配置或加载失败。') + '</div>' +
      '</div></div>';
  }

  const group = entry.group || {};
  const models = Array.isArray(group.models) ? group.models : [];
  const current = currentSelection();
  const defaultSelection = S.models.default || null;
  const isDefaultProvider = defaultSelection && defaultSelection.provider === group.id;

  let html = '<div class="provider-pane"><div class="provider-card">';
  html += '<div class="provider-head"><h2 class="provider-name">' + escapeHtml(group.name || group.id) + '</h2>' +
    (isDefaultProvider ? '<span class="mini-pill">默认</span>' : '') +
    '</div>';

  if (!models.length) {
    html += '<p class="failure-msg">该供应商没有返回可用模型。</p>';
  }

  for (const model of models) {
    const isCurrent = current && current.provider === group.id && current.model === model.id;
    const isDefaultModel = defaultSelection && defaultSelection.provider === group.id && defaultSelection.model === model.id;
    const reasoning = model.reasoning && Array.isArray(model.reasoning.efforts) ? model.reasoning.efforts : [];
    const effortNames = reasoning.map((effort) => effort.name || effort.id).join(' / ');
    const description = [model.description || '', reasoning.length ? '推理档位：' + effortNames : ''].filter(Boolean).join(' · ');
    html += '<button class="model-row" data-action="select-setting-model" data-provider="' + escapeHtml(group.id) + '" data-model="' + escapeHtml(model.id) + '">' +
      '<div class="model-row-main">' +
      '<div class="model-row-name">' + escapeHtml(model.name || model.id) + (isDefaultModel ? '<span class="mini-pill">默认</span>' : '') + '</div>' +
      (description ? '<div class="model-row-desc">' + escapeHtml(description) + '</div>' : '') +
      '</div>' +
      (isCurrent ? svgIcon('checkCircle', 'sheet-check') : '') +
      '</button>';
  }

  html += '</div></div>';
  return html;
}

/* ------------------------------------------------------------------ */
/* 12. 鉴权 / 失效状态页                                               */
/* ------------------------------------------------------------------ */

function authIllustration() {
  return `<svg class="auth-art" viewBox="0 0 128 128" fill="none" aria-hidden="true">
  <rect x="33" y="12" width="62" height="104" rx="13" stroke="currentColor" stroke-width="1.5"/>
  <path d="M53 22.5h22" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
  <rect x="45" y="42" width="38" height="34" rx="7" stroke="currentColor" stroke-width="1.5" stroke-dasharray="4 5"/>
  <circle cx="64" cy="59" r="11" stroke="currentColor" stroke-width="1.75"/>
  <path d="M64 53.5v6.5" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/>
  <circle cx="64" cy="65" r="1.1" fill="currentColor"/>
  <path d="M64 88v10M50 98h28" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
</svg>`;
}

function authPageHtml(kind) {
  let title = '需要连接电脑端';
  let text = '尚未检测到连接凭证。请回到电脑端打开「移动端远程控制」，用手机重新扫码连接。';
  let hint = '连接凭证只保存在本机浏览器中，不会上传到任何服务器。';
  if (kind === 'invalid') {
    title = '连接已失效';
    text = '连接凭证无效或二维码已被刷新。请回到电脑端重新扫码，使用最新二维码连接当前工作区。';
    hint = '若电脑端已刷新二维码，请直接扫描最新二维码。';
  } else if (kind === 'stopped') {
    title = '远程控制已暂停';
    text = '电脑端已停止远程控制服务。请在桌面端重新开启后，再刷新本页。';
    hint = '停止后所有手机端连接都会被断开。';
  }
  return `<section class="auth-page">
  ${authIllustration()}
  <h1 class="auth-title">${title}</h1>
  <p class="auth-text">${text}</p>
  <button class="auth-btn" data-action="reload-page">重新加载</button>
  <p class="auth-hint">${hint}</p>
</section>`;
}


/* ------------------------------------------------------------------ */
/* 13. 底部 sheet 渲染                                                 */
/* ------------------------------------------------------------------ */

function openSheet(sheet) {
  S.ui.sheet = sheet;
  renderSheet();
}

function closeSheet() {
  if (!S.ui.sheet) return;
  S.ui.sheet = null;
  renderSheet();
}

function sheetTitle(sheet) {
  if (!sheet) return '';
  if (sheet.type === 'model') return '选择模型';
  if (sheet.type === 'workspace') return '选择工作区';
  if (sheet.type === 'info') return '连接信息';
  if (sheet.type === 'menu') return '会话操作';
  if (sheet.type === 'filter') return '筛选';
  if (sheet.type === 'workspace-info') return '工作区信息';
  if (sheet.type === 'attach') return '添加图片';
  return '操作';
}

function renderSheet() {
  if (!sheetRoot) return;
  const sheet = S.ui.sheet;
  if (!sheet) {
    sheetRoot.innerHTML = '';
    return;
  }
  const title = sheetTitle(sheet);
  sheetRoot.innerHTML = '<div class="sheet-backdrop" data-action="close-sheet">' +
    '<div class="sheet" role="dialog" aria-modal="true" aria-label="' + escapeHtml(title) + '">' +
    '<div class="sheet-grabber"></div>' +
    '<div class="sheet-head"><h2 class="sheet-title">' + escapeHtml(title) + '</h2><button class="icon-btn sheet-close" data-action="close-sheet" aria-label="关闭">' + svgIcon('close') + '</button></div>' +
    '<div class="sheet-body">' + sheetBodyHtml(sheet) + '</div>' +
    '</div></div>';
}

function sheetBodyHtml(sheet) {
  if (sheet.type === 'model') return modelSheetHtml();
  if (sheet.type === 'workspace') return workspaceSheetHtml();
  if (sheet.type === 'info') return infoSheetHtml();
  if (sheet.type === 'menu') return menuSheetHtml();
  if (sheet.type === 'filter') return filterSheetHtml();
  if (sheet.type === 'workspace-info') return workspaceInfoSheetHtml();
  if (sheet.type === 'attach') return attachSheetHtml();
  return '';
}

function attachSheetHtml() {
  const row = (source, icon, title, desc) =>
    '<button class="sheet-row"' + ' data-action="pick-image" data-source="' + source + '">' +
    '<span class="sheet-row-icon">' + svgIcon(icon) + '</span>' +
    '<span class="sheet-row-main"><span class="sheet-row-title"><span>' + title + '</span></span>' +
    '<span class="sheet-row-desc">' + desc + '</span></span>' +
    svgIcon('chevronRight', 'chev') +
    '</button>';
  return row('camera', 'camera', '拍照', '调用相机拍摄一张图片') +
    row('album', 'image', '从相册选择', '选择手机里已有的图片') +
    '<p class="sheet-note">支持 PNG / JPEG / WebP / GIF，单张不超过 10MB，最多 ' + MAX_CHAT_IMAGES + ' 张。发送前会先上传到电脑端 DSH。</p>';
}

function orderedModelGroups(catalog) {
  const groups = Array.isArray(catalog && catalog.groups) ? catalog.groups.slice() : [];
  const current = currentSelection();
  if (!current || !current.provider) return groups;
  const index = groups.findIndex((group) => group.id === current.provider);
  if (index > 0) {
    const group = groups.splice(index, 1)[0];
    groups.unshift(group);
  }
  return groups;
}

function modelSheetHtml() {
  const catalog = S.models;
  if (!catalog || !Array.isArray(catalog.groups)) {
    return '<div class="state-box"><span class="spinner"></span><p class="state-text" style="margin-top:14px">正在读取模型目录…</p></div>';
  }

  const current = (S.chat && S.chat.model) || catalog.default || null;
  const effortFor = S.ui.sheet && S.ui.sheet.effortFor;
  let html = '';

  for (const group of orderedModelGroups(catalog)) {
    html += '<div class="sheet-group-label">' + escapeHtml(group.name || group.id) + '</div>';
    const models = Array.isArray(group.models) ? group.models : [];
    for (const model of models) {
      const key = group.id + ':' + model.id;
      const isCurrent = !!current && current.provider === group.id && current.model === model.id;
      const efforts = model.reasoning && Array.isArray(model.reasoning.efforts) ? model.reasoning.efforts : [];
      const expanded = efforts.length > 0 && effortFor === key;
      html += '<div class="model-row-wrap' + (isCurrent ? ' is-current' : '') + '">';
      html += '<button class="model-row-btn" data-action="select-model-row" data-provider="' + escapeHtml(group.id) + '" data-model="' + escapeHtml(model.id) + '">';
      html += '<div class="sheet-row-main">';
      html += '<div class="sheet-row-title"><span>' + escapeHtml(model.name || model.id) + '</span>' + (isCurrent ? '<span class="mini-pill">当前</span>' : '') + '</div>';
      if (model.description) html += '<div class="sheet-row-desc">' + escapeHtml(model.description) + '</div>';
      html += '</div>';
      if (isCurrent) html += svgIcon('check', 'sheet-check');
      else if (efforts.length) html += svgIcon('chevronDown', 'chev');
      else html += svgIcon('chevronRight', 'chev');
      html += '</button>';
      if (expanded) html += effortsHtml(group, model, current);
      html += '</div>';
    }
  }

  const failures = Array.isArray(catalog.failures) ? catalog.failures : [];
  if (failures.length) {
    html += '<div class="sheet-group-label">加载失败</div>';
    for (const failure of failures) {
      html += '<div class="sheet-row"><div class="sheet-row-main">' +
        '<div class="sheet-row-title"><span>' + escapeHtml(failure.name || failure.id) + '</span></div>' +
        '<div class="sheet-row-desc">' + escapeHtml(failure.message || '未配置或加载失败') + '</div>' +
        '</div></div>';
    }
  }

  html += '<button class="sheet-link-row" data-action="open-model-settings">' + svgIcon('settings', 'ico-sm') + '模型设置</button>';
  html += '<p class="sheet-note">模型来自当前 DSH 配置；选择后立即用于当前会话，并保存为默认。</p>';
  return html;
}

function effortsHtml(group, model, current) {
  const reasoning = model.reasoning || {};
  const efforts = Array.isArray(reasoning.efforts) ? reasoning.efforts : [];
  const isCurrent = !!current && current.provider === group.id && current.model === model.id;
  const active = (isCurrent && current.reasoningEffort) || reasoning.defaultEffort || (efforts[0] && efforts[0].id);
  let html = '<div class="efforts">';
  for (const effort of efforts) {
    html += '<button class="effort-btn' + (effort.id === active ? ' on' : '') + '" data-action="select-effort" data-provider="' + escapeHtml(group.id) + '" data-model="' + escapeHtml(model.id) + '" data-effort="' + escapeHtml(effort.id) + '">' + escapeHtml(effort.name || effort.id) + '</button>';
  }
  html += '</div>';
  return html;
}

function workspaceSheetHtml() {
  const sheet = S.ui.sheet || {};
  if (sheet.creating) {
    return '<div class="state-box"><span class="spinner"></span><p class="state-text" style="margin-top:14px">正在创建任务…</p></div>';
  }
  const workspaces = S.workspaces || [];
  let html = '<p class="sheet-note" style="margin-top:0">任务会创建在所选工作区中，并立即打开会话。</p>';
  if (!workspaces.length) {
    html += '<div class="state-box"><p class="state-text">没有读取到可用工作区。</p><button class="btn" data-action="reload-workspaces">重新读取</button></div>';
    return html;
  }
  for (const workspace of workspaces) {
    html += '<button class="ws-row" data-action="create-workspace" data-id="' + escapeHtml(workspace.id) + '">' +
      '<span class="ws-mono">' + escapeHtml(monogram(workspace.title || workspace.id)) + '</span>' +
      '<div class="ws-main"><div class="ws-title">' + escapeHtml(maskSecretsPlain(workspace.title || workspace.id)) + '</div><div class="ws-path">' + escapeHtml(workspace.path || '') + '</div></div>' +
      svgIcon('chevronRight', 'chev') +
      '</button>';
  }
  if (sheet.error) {
    html += '<p class="sheet-note" style="color:var(--red)">' + escapeHtml(sheet.error) + '</p>';
  }
  return html;
}

function infoSheetHtml() {
  const boot = S.boot || {};
  const server = boot.server || {};
  const counts = currentCounts();
  const rows = [
    ['服务版本', server.version || '—'],
    ['主机', server.hostName || '—'],
    ['平台', server.platform || '—'],
    ['协议版本', server.protocol ? 'v' + server.protocol : '—'],
    ['已连接设备', typeof boot.deviceCount === 'number' ? boot.deviceCount + ' 台' : '—'],
    ['工作区 / 任务', counts.workspaces + ' 个 / ' + counts.sessions + ' 个'],
    ['默认模型', modelDisplayName((S.models && S.models.default) || boot.defaultModel)],
  ];
  let html = '<div class="info-list">';
  for (const row of rows) {
    html += '<div class="info-row"><span class="info-label">' + escapeHtml(row[0]) + '</span><span class="info-value">' + escapeHtml(row[1]) + '</span></div>';
  }
  html += '</div>';
  html += '<button class="sheet-link-row" data-action="open-model-settings">' + svgIcon('settings', 'ico-sm') + '模型设置</button>';
  html += '<p class="sheet-note">连接凭证由电脑端生成，刷新二维码后旧的凭证会立即失效。</p>';
  if (S.mock) html += '<p class="sheet-note" style="color:var(--orange)">当前为开发自检模式（?mock=1），数据来自本地 mock。</p>';
  return html;
}

function menuSheetHtml() {
  const chat = S.chat;
  const rows = [
    ['refresh-session', 'refresh', '刷新会话', '重新拉取当前会话快照'],
    ['copy-session-id', 'copy', '复制会话 ID', chat ? chat.sessionId : ''],
    ['open-model-settings', 'settings', '模型设置', '查看全部供应商与模型'],
  ];
  let html = '';
  for (const row of rows) {
    html += '<button class="sheet-row" data-action="' + row[0] + '">' +
      svgIcon(row[1], 'ico-sm') +
      '<div class="sheet-row-main"><div class="sheet-row-title"><span>' + row[2] + '</span></div>' +
      (row[3] ? '<div class="sheet-row-desc">' + escapeHtml(row[3]) + '</div>' : '') +
      '</div></button>';
  }
  html += '<div class="sheet-divider"></div>';
  html += '<button class="sheet-row" data-action="chat-to-list">' + svgIcon('back', 'ico-sm') +
    '<div class="sheet-row-main"><div class="sheet-row-title"><span>回到任务列表</span></div></div></button>';
  return html;
}

function filterSheetHtml() {
  return '<button class="switch-row" data-action="toggle-only-running">' +
    '<div class="switch-row-main"><div class="switch-row-title">仅显示进行中</div><div class="switch-row-desc">只保留正在运行的远程任务</div></div>' +
    '<span class="switch' + (S.tasks.onlyRunning ? ' on' : '') + '" aria-hidden="true"></span>' +
    '</button>' +
    '<p class="sheet-note">筛选只影响当前手机端列表，不会改变电脑端任务状态。</p>';
}

function workspaceInfoSheetHtml() {
  const chat = S.chat;
  const summary = (chat && chat.summary) || {};
  const path = summary.workspacePath || '';
  let html = '<div class="info-list">';
  html += '<div class="info-row"><span class="info-label">工作区</span><span class="info-value">' + escapeHtml(maskSecretsPlain(summary.workspaceTitle || '任务')) + '</span></div>';
  html += '<div class="info-row"><span class="info-label">路径</span><span class="info-value">' + escapeHtml(path || '—') + '</span></div>';
  html += '<div class="info-row"><span class="info-label">会话</span><span class="info-value">' + escapeHtml(maskSecretsPlain(summary.title || '—')) + '</span></div>';
  html += '</div>';
  if (path) {
    html += '<button class="sheet-link-row" data-action="copy-workspace-path" data-path="' + escapeHtml(path) + '">' + svgIcon('copy', 'ico-sm') + '复制工作区路径</button>';
  }
  return html;
}

/* ------------------------------------------------------------------ */
/* 14. 会话数据操作                                                    */
/* ------------------------------------------------------------------ */

function applyChanges(list) {
  const chat = S.chat;
  if (!chat || !Array.isArray(list)) return;
  for (const item of list) {
    if (!item) continue;
    const summary = item.summary || null;
    let turn = typeof item.turn === 'number' ? item.turn : null;
    if (turn === null && summary && typeof summary.turn === 'number') turn = summary.turn;
    if (turn === null) continue;
    if (!summary || !Array.isArray(summary.files) || summary.files.length === 0) {
      // Host 重启后旧轮次的 summary 可能为 null，或已无文件明细，直接跳过。
      delete chat.changes[turn];
      continue;
    }
    chat.changes[turn] = { seq: item.seq, turn, summary };
  }
}

function applyTurns(chat, list) {
  if (!chat || !Array.isArray(list)) return;
  if (!chat.turns) chat.turns = {};
  for (const item of list) {
    if (!item || typeof item.turn !== 'number') continue;
    const previous = chat.turns[item.turn] || {};
    chat.turns[item.turn] = {
      startedAt: typeof item.startedAt === 'number' ? item.startedAt : previous.startedAt,
      endedAt: typeof item.endedAt === 'number' ? item.endedAt : previous.endedAt,
      reasonKind: item.reasonKind !== undefined ? item.reasonKind : previous.reasonKind,
    };
  }
}

function mergeMessageLists(incoming, existing) {
  const list = incoming.map((item) => Object.assign({}, item));
  const hasId = (id) => list.some((item) => item.id === id);

  for (const old of existing || []) {
    if (hasId(old.id)) continue;
    if (old.live) {
      list.push(old);
      continue;
    }
    if (isLocalMessage(old)) {
      const duplicate = list.some((item) => item.role === 'user' && messageText(item) === messageText(old));
      if (!duplicate) list.push(old);
      continue;
    }
    if (typeof old.seq === 'number') list.push(old);
  }

  return sortMessages(list);
}

function applyOpenedData(sessionId, data) {
  const chat = S.chat;
  if (!chat || chat.sessionId !== sessionId) return;

  chat.loading = false;
  chat.error = null;

  if (data.summary) {
    chat.summary = data.summary;
    upsertSessionSummary(data.summary);
  }
  if (data.model !== undefined) chat.model = data.model;
  if (typeof data.running === 'boolean') {
    if (data.running && !chat.running) chat.runningStartedAt = Date.now();
    if (!data.running) {
      chat.runningStartedAt = 0;
      chat.runningTurn = null;
    }
    chat.running = data.running;
  }
  chat.hasMore = !!data.hasMore;
  if (typeof data.oldestSeq === 'number') chat.oldestSeq = data.oldestSeq;
  else if (data.oldestSeq === null) chat.oldestSeq = null;
  if (Array.isArray(data.changes)) applyChanges(data.changes);
  chat.usage = data.usage || chat.usage || null;
  if (Array.isArray(data.deliverables)) chat.deliverables = data.deliverables;
  if (Array.isArray(data.turns)) applyTurns(chat, data.turns);
  if (Array.isArray(data.messages)) chat.messages = mergeMessageLists(data.messages, chat.messages);

  clearTimeout(chatOpenTimer);
  renderMessages();
  updateChatChrome();
  updateComposer();
  updateLoadOlder();
}

function handleSessionEvent(sessionId, event) {
  const chat = S.chat;
  if (!chat || chat.sessionId !== sessionId || !event) return;

  switch (event.kind) {
    case 'message':
    case 'message-update':
      if (event.message) upsertMessage(event.message);
      break;
    case 'stream':
      applyStreamEvent(event);
      break;
    case 'stream-start':
      startLiveMessage(event);
      break;
    case 'status': {
      chat.running = !!event.running;
      if (typeof event.turn === 'number') {
        chat.runningTurn = event.turn;
        if (!chat.turns) chat.turns = {};
        const meta = chat.turns[event.turn] || {};
        if (typeof event.time === 'number') {
          if (event.running) {
            if (typeof meta.startedAt !== 'number') meta.startedAt = event.time;
          } else if (typeof meta.endedAt !== 'number') {
            meta.endedAt = event.time;
          }
        }
        if (event.reasonKind !== undefined) meta.reasonKind = event.reasonKind;
        chat.turns[event.turn] = meta;
      }
      if (event.running) {
        if (!chat.runningStartedAt) chat.runningStartedAt = Date.now();
      } else {
        chat.runningStartedAt = 0;
        chat.runningTurn = null;
        finalizeLiveMessage();
      }
      renderMessages();
      updateChatChrome();
      break;
    }
    case 'title':
      if (event.title) {
        chat.summary = Object.assign({}, chat.summary || {}, { title: event.title });
        upsertSessionSummary(Object.assign({}, chat.summary, { id: chat.sessionId }));
        updateChatChrome();
      }
      break;
    case 'model':
      if (event.selection) {
        chat.model = event.selection;
        updateChatChrome();
      }
      break;
    case 'changes':
      applyChanges([{ seq: event.seq, turn: event.turn, summary: event.summary }]);
      renderMessages();
      break;
    case 'todo':
      chat.todos = Array.isArray(event.todos) ? event.todos : [];
      break;
    case 'turn-end': {
      chat.running = false;
      chat.runningStartedAt = 0;
      chat.runningTurn = null;
      finalizeLiveMessage();
      chat.lastError = event.ok ? null : { turn: event.turn, message: (event.error && (event.error.message || event.error.code)) || '本轮执行失败' };
      if (typeof event.turn === 'number') {
        if (!chat.turns) chat.turns = {};
        const meta = chat.turns[event.turn] || {};
        if (typeof event.time === 'number') meta.endedAt = event.time;
        if (event.reasonKind !== undefined) meta.reasonKind = event.reasonKind;
        else if (event.ok === false) meta.reasonKind = 'error';
        chat.turns[event.turn] = meta;
        // 回合结束默认折叠过程；用户之后手动展开的选择保留到重新打开会话。
        chat.expandedTurns.delete('turn:' + event.turn);
      }
      renderMessages();
      updateChatChrome();
      break;
    }
    default:
      break;
  }
}

function imageCountOf(message) {
  if (!message || !Array.isArray(message.blocks)) return 0;
  return message.blocks.filter((block) => block && block.type === 'image').length;
}

function upsertMessage(message) {
  const chat = S.chat;
  if (!chat || !message || !message.id) return;

  const list = chat.messages;
  const index = list.findIndex((item) => item.id === message.id);

  if (index >= 0) {
    list[index] = Object.assign({}, message);
  } else if (message.role === 'user') {
    const localIndex = list.findIndex((item) => isLocalMessage(item) && item.role === 'user' &&
      messageText(item) === messageText(message) && imageCountOf(item) === imageCountOf(message));
    if (localIndex >= 0) list[localIndex] = Object.assign({}, message);
    else list.push(Object.assign({}, message));
  } else {
    // 最终消息到达后，移除流式临时消息（含已结束的 partial）
    chat.messages = list.filter((item) => !item.live && String(item.id).indexOf('live-') !== 0);
    chat.messages.push(Object.assign({}, message));
    chat.liveAttempt = null;
    // 用户已上滑离开底部：累计未读，显示在「回到底部」按钮上
    if (!chat.stick) chat.unreadCount = (Number(chat.unreadCount) || 0) + 1;
  }

  chat.messages = sortMessages(chat.messages);
  trimMessages(chat);
  renderMessages();
  updateChatChrome();
  updateJumpButton();
}



/* 消息列表软上限：长会话（数百条）在手机上会持续吃内存并拖慢渲染。
 * 只裁剪最旧的、且仅当用户不在顶部附近（避免打断「加载更早」）。 */
const MESSAGE_SOFT_CAP = 400;
const MESSAGE_TRIM_TO = 300;

function trimMessages(chat) {
  const list = chat.messages || [];
  if (list.length <= MESSAGE_SOFT_CAP) return false;
  const keep = list.slice(list.length - MESSAGE_TRIM_TO);
  // 保留仍在流式的 live 消息，避免裁剪后丢失进行中的输出
  for (const live of list) {
    if (live && live.live && !keep.includes(live)) keep.push(live);
  }
  chat.messages = sortMessages(keep);
  chat.trimmed = true;
  return true;
}

function currentTurnOf(chat) {
  const messages = chat.messages || [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (typeof messages[index].turn === 'number') return messages[index].turn;
  }
  return null;
}

function startLiveMessage(event) {
  const chat = S.chat;
  if (!chat || !event.attemptId) return;
  const id = 'live-' + event.attemptId;
  if (!chat.messages.some((item) => item.id === id)) {
    chat.messages.push({
      id,
      seq: null,
      role: 'assistant',
      time: Date.now(),
      turn: typeof event.turn === 'number' ? event.turn : currentTurnOf(chat),
      step: event.step,
      blocks: [],
      live: true,
    });
    chat.messages = sortMessages(chat.messages);
  }
  chat.liveAttempt = event.attemptId;
  chat.running = true;
  if (typeof event.turn === 'number') chat.runningTurn = event.turn;
  if (!chat.runningStartedAt) chat.runningStartedAt = Date.now();
  chat.lastError = null;
  renderMessages();
  updateChatChrome();
}

function applyStreamEvent(event) {
  const chat = S.chat;
  if (!chat || !event.attemptId) return;
  const id = 'live-' + event.attemptId;
  let message = chat.messages.find((item) => item.id === id);

  if (!message) {
    message = { id, seq: null, role: 'assistant', time: Date.now(), turn: typeof event.turn === 'number' ? event.turn : currentTurnOf(chat), step: event.step, blocks: [], live: true };
    chat.messages.push(message);
    chat.liveAttempt = event.attemptId;
    chat.messages = sortMessages(chat.messages);
  }

  chat.running = true;
  if (typeof event.turn === 'number') chat.runningTurn = event.turn;
  if (!chat.runningStartedAt) chat.runningStartedAt = Date.now();

  const type = event.block === 'reasoning' ? 'reasoning' : 'text';
  const blocks = message.blocks;
  const last = blocks[blocks.length - 1];
  const chunk = String(event.text === undefined || event.text === null ? '' : event.text);
  if (!last || last.type !== type) blocks.push({ type, text: chunk });
  else last.text = (last.text || '') + chunk;

  scheduleLiveRender();
}

function scheduleLiveRender() {
  if (liveRenderTimer) return;
  const wait = Math.max(0, 90 - (Date.now() - lastLiveRender));
  liveRenderTimer = setTimeout(() => {
    liveRenderTimer = null;
    lastLiveRender = Date.now();
    renderMessages();
    updateChatChrome();
  }, wait);
}

function finalizeLiveMessage() {
  const chat = S.chat;
  if (!chat) return;
  chat.messages = chat.messages.filter((item) => {
    if (!item.live) return true;
    item.live = false;
    const allText = (item.blocks || []).map((block) => block.text || '').join('').trim();
    return allText.length > 0;
  });
  chat.liveAttempt = null;
}

async function loadOlder() {
  const chat = S.chat;
  const scroller = document.getElementById('chat-scroll');
  if (!chat || !scroller || chat.loadingOlder || !chat.hasMore) return;
  if (typeof chat.oldestSeq !== 'number') {
    chat.hasMore = false;
    updateLoadOlder();
    return;
  }

  chat.loadingOlder = true;
  updateLoadOlder();
  const previousHeight = scroller.scrollHeight;
  const previousTop = scroller.scrollTop;

  try {
    const data = await net.request('/api/sessions/' + encodeURIComponent(chat.sessionId) + '/history?beforeSeq=' + encodeURIComponent(chat.oldestSeq) + '&maxMessages=60');
    if (!S.chat || S.chat.sessionId !== chat.sessionId) return;
    const incoming = data && Array.isArray(data.messages) ? data.messages : [];
    chat.messages = mergeMessageLists(incoming, chat.messages);
    chat.hasMore = !!(data && data.hasMore) && incoming.length > 0;
    if (data && typeof data.oldestSeq === 'number') chat.oldestSeq = data.oldestSeq;
    if (data && Array.isArray(data.changes)) applyChanges(data.changes);
    if (data && Array.isArray(data.turns)) applyTurns(chat, data.turns);
    renderMessages({ keepScroll: true });
    scroller.scrollTop = scroller.scrollHeight - previousHeight + previousTop;
    updateJumpButton();
  } catch (error) {
    if (isAuthError(error)) return handleAuthError(error);
    toast('加载更早消息失败：' + error.message);
  } finally {
    chat.loadingOlder = false;
    updateLoadOlder();
  }
}

function openChat(sessionId) {
  if (!sessionId) return;
  const previous = S.chat;

  if (previous && previous.sessionId !== sessionId && socket && socket.isOpen()) {
    wsSend({ type: 'close', sessionId: previous.sessionId });
  }

  let chat;
  if (previous && previous.sessionId === sessionId) {
    chat = previous;
    chat.error = null;
    if (!(chat.messages || []).length) chat.loading = true;
  } else {
    chat = makeChat(sessionId);
  }
  S.chat = chat;

  // 重新打开会话时恢复默认折叠（running 回合本来就没有折叠行）。
  if (chat.expandedTurns) chat.expandedTurns.clear();
  if (chat.expandedProcessGroups) chat.expandedProcessGroups.clear();

  renderChat();
  clearTimeout(chatOpenTimer);

  if (socket && socket.isOpen()) {
    wsSend({ type: 'open', sessionId });
    chatOpenTimer = setTimeout(() => {
      const current = S.chat;
      if (current && current.sessionId === sessionId && current.loading) loadSessionViaHttp(sessionId);
    }, 3500);
  } else {
    loadSessionViaHttp(sessionId);
  }
}

async function loadSessionViaHttp(sessionId) {
  try {
    const data = await net.request('/api/sessions/' + encodeURIComponent(sessionId));
    if (!S.chat || S.chat.sessionId !== sessionId) return;
    applyOpenedData(sessionId, data || {});
  } catch (error) {
    if (isAuthError(error)) return handleAuthError(error);
    const chat = S.chat;
    if (!chat || chat.sessionId !== sessionId) return;
    chat.loading = false;
    chat.error = error.message || '无法打开会话';
    renderMessages();
    updateChatChrome();
  }
}

/* ------------------------------------------------------------------ */
/* 15. 发送 / 停止 / 模型 / 新建任务 / 刷新                            */
/* ------------------------------------------------------------------ */

function sendPrompt(overrideText, options) {
  const chat = S.chat;
  if (!chat || !chat.sessionId || chat.running) return;

  const opts = options || {};
  const localImages = Array.isArray(opts.localImages) ? opts.localImages : [];
  const wireAttachments = Array.isArray(opts.attachments) && opts.attachments.length ? opts.attachments : null;
  const text = String(overrideText === undefined || overrideText === null ? chat.draft : overrideText).trim();
  if (!text && !localImages.length) {
    toast('请输入内容');
    return;
  }

  const blocks = localImages.map((attachment) => ({
    type: 'image',
    attachmentId: 'pending-' + attachment.id,
    mediaType: attachment.mediaType,
    width: attachment.width,
    height: attachment.height,
    previewUrl: attachment.dataUrl,
  }));
  if (text) blocks.push({ type: 'text', text });

  const requestId = 'req-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  const localId = 'local-' + requestId;
  chat.messages.push({ id: localId, seq: null, role: 'user', time: Date.now(), blocks, pending: true });
  chat.pending.set(requestId, { localId, text });
  chat.draft = '';
  chat.attachments = [];
  const textarea = document.getElementById('composer-input');
  if (textarea) {
    textarea.value = '';
    autoGrowComposer(textarea);
  }
  chat.running = true;
  chat.runningStartedAt = Date.now();
  chat.runningTurn = null;
  chat.lastError = null;
  chat.stick = true;
  renderMessages();
  renderComposerAttachments();
  updateChatChrome();
  updateComposer();

  const payload = { text, requestId };
  if (wireAttachments) payload.attachments = wireAttachments;
  if (socket && socket.isOpen()) {
    wsSend(Object.assign({ type: 'prompt', sessionId: chat.sessionId }, payload));
  } else {
    net.request('/api/sessions/' + encodeURIComponent(chat.sessionId) + '/prompt', { method: 'POST', body: payload })
      .catch((error) => handlePromptFailure(requestId, error));
  }

  setTimeout(() => {
    const current = S.chat;
    if (!current || !current.pending.has(requestId)) return;
    toast('发送确认较慢，请检查电脑端连接');
  }, 15000);
}

async function sendCurrentPrompt() {
  const chat = S.chat;
  if (!chat || !chat.sessionId || chat.running || chat.uploading) return;
  const selected = Array.isArray(chat.attachments) ? chat.attachments.slice() : [];
  if (!selected.length) {
    sendPrompt();
    return;
  }
  const text = String(chat.draft || '').trim();
  chat.uploading = true;
  updateSendButton();
  renderComposerAttachments();
  try {
    const attachments = [];
    const localImages = [];
    for (const attachment of selected) {
      if (S.mock) {
        // 开发 mock：不发起真实上传，直接随 prompt 交给 mock 回放。
        attachments.push({
          mediaType: attachment.mediaType,
          dataBase64: attachment.dataBase64,
          name: attachment.name,
          previewUrl: attachment.dataUrl,
          width: attachment.width,
          height: attachment.height,
        });
      } else {
        const result = await net.request('/api/sessions/' + encodeURIComponent(chat.sessionId) + '/upload', {
          method: 'POST',
          body: { mediaType: attachment.mediaType, dataBase64: attachment.dataBase64, name: attachment.name },
        });
        if (!result || !result.receiptId) throw new Error('上传接口未返回 receiptId');
        attachments.push({ receiptId: result.receiptId });
      }
      localImages.push(attachment);
    }
    chat.uploading = false;
    sendPrompt(text, { attachments, localImages });
  } catch (error) {
    chat.uploading = false;
    updateSendButton();
    renderComposerAttachments();
    if (isAuthError(error)) return handleAuthError(error);
    toast('图片上传失败：' + (error.message || '未知错误'));
  }
}

function handlePromptFailure(requestId, error) {
  const chat = S.chat;
  if (!chat) return;
  const entry = chat.pending.get(requestId);
  chat.pending.delete(requestId);
  const local = entry ? chat.messages.find((item) => item.id === entry.localId) : null;
  if (local) {
    local.pending = false;
    local.failed = true;
  }
  chat.running = false;
  chat.runningStartedAt = 0;
  renderMessages();
  updateChatChrome();
  if (isAuthError(error)) return handleAuthError(error);
  toast('发送失败：' + (error.message || '未知错误'));
}

function cancelRun() {
  const chat = S.chat;
  if (!chat || !chat.running) return;
  const requestId = 'cancel-' + Date.now().toString(36);
  if (socket && socket.isOpen()) {
    wsSend({ type: 'cancel', sessionId: chat.sessionId, requestId });
    toast('正在停止…');
    return;
  }
  net.request('/api/sessions/' + encodeURIComponent(chat.sessionId) + '/cancel', { method: 'POST', body: {} })
    .then(() => toast('正在停止…'))
    .catch((error) => {
      if (isAuthError(error)) return handleAuthError(error);
      toast('停止失败：' + error.message);
    });
}

function resendBefore(messageId) {
  const chat = S.chat;
  if (!chat) return;
  if (chat.running) {
    toast('正在运行，请先停止当前任务');
    return;
  }
  const index = chat.messages.findIndex((item) => item.id === messageId);
  if (index < 0) {
    toast('没有找到可重试的消息');
    return;
  }
  for (let cursor = index; cursor >= 0; cursor -= 1) {
    const message = chat.messages[cursor];
    if (message.role === 'user' && !message.failed) {
      const text = messageText(message).trim();
      if (text) {
        sendPrompt(text);
        return;
      }
    }
  }
  toast('前面没有可重发的用户消息');
}

async function openModelSheet() {
  if (!S.chat) {
    toast('请先打开一个任务会话');
    return;
  }
  if (!S.models) {
    try {
      const data = await net.request('/api/bootstrap');
      applyBootstrap(data);
    } catch (error) {
      if (isAuthError(error)) return handleAuthError(error);
      toast('模型目录加载失败：' + error.message);
      return;
    }
  }
  const current = S.chat.model || (S.models && S.models.default) || null;
  let effortFor = null;
  if (current) {
    const def = findModelDef(current.provider, current.model);
    if (def && def.reasoning && Array.isArray(def.reasoning.efforts) && def.reasoning.efforts.length) {
      effortFor = current.provider + ':' + current.model;
    }
  }
  S.ui.sheet = { type: 'model', effortFor };
  renderSheet();
}

function selectModelRow(element) {
  const providerId = element.getAttribute('data-provider');
  const modelId = element.getAttribute('data-model');
  const def = findModelDef(providerId, modelId);
  const hasEfforts = !!(def && def.reasoning && Array.isArray(def.reasoning.efforts) && def.reasoning.efforts.length);

  if (!hasEfforts) {
    chooseModel(providerId, modelId, null);
    return;
  }

  const sheet = S.ui.sheet || { type: 'model' };
  const key = providerId + ':' + modelId;
  sheet.effortFor = sheet.effortFor === key ? null : key;
  S.ui.sheet = sheet;
  renderSheet();
}

function chooseModel(providerId, modelId, effortId) {
  const chat = S.chat;
  if (!chat) {
    toast('请先打开一个任务会话，再切换模型');
    return;
  }

  const def = findModelDef(providerId, modelId);
  let reasoningEffort = effortId || null;
  if (!reasoningEffort && def && def.reasoning) {
    if (def.reasoning.defaultEffort) reasoningEffort = def.reasoning.defaultEffort;
    else if (Array.isArray(def.reasoning.efforts) && def.reasoning.efforts.length) reasoningEffort = def.reasoning.efforts[0].id;
  }

  const selection = { provider: providerId, model: modelId };
  if (reasoningEffort) selection.reasoningEffort = reasoningEffort;

  const previous = chat.model;
  chat.model = selection;
  const session = findSession(chat.sessionId);
  if (session) session.model = selection;

  closeSheet();
  if (S.route.name === 'chat') updateChatChrome();
  if (S.route.name === 'models') renderSettings();
  toast('已切换到 ' + (def ? def.name || def.id : modelId));

  const payload = { type: 'model', sessionId: chat.sessionId, provider: providerId, model: modelId };
  if (reasoningEffort) payload.reasoningEffort = reasoningEffort;

  if (socket && socket.isOpen()) {
    wsSend(payload);
  } else {
    net.request('/api/sessions/' + encodeURIComponent(chat.sessionId) + '/model', { method: 'POST', body: selection }).catch((error) => {
      if (isAuthError(error)) return handleAuthError(error);
      chat.model = previous;
      if (S.route.name === 'chat') updateChatChrome();
      if (S.route.name === 'models') renderSettings();
      toast('切换模型失败：' + error.message);
    });
  }
}

async function refreshModels(silent) {
  if (S.settings.refreshing) return;
  S.settings.refreshing = true;
  if (S.route.name === 'models') renderSettings();
  try {
    const data = await net.request('/api/bootstrap');
    applyBootstrap(data);
    if (!silent) toast('模型目录已更新');
  } catch (error) {
    if (isAuthError(error)) return handleAuthError(error);
    if (!silent) toast('刷新失败：' + error.message);
  } finally {
    S.settings.refreshing = false;
    if (S.route.name === 'models') renderSettings();
    else if (S.route.name === 'chat') updateChatChrome();
  }
}

async function newTask() {
  if (!S.workspaces.length) {
    try {
      const data = await net.request('/api/bootstrap');
      applyBootstrap(data);
    } catch (error) {
      if (isAuthError(error)) return handleAuthError(error);
      toast('读取工作区失败：' + error.message);
      return;
    }
  }
  openSheet({ type: 'workspace', creating: false, error: null });
}

async function createInWorkspace(workspaceId) {
  const sheet = S.ui.sheet;
  if (!sheet || sheet.creating || !workspaceId) return;
  sheet.creating = true;
  sheet.error = null;
  renderSheet();

  try {
    const data = await net.request('/api/sessions', { method: 'POST', body: { workspaceId } });
    const sessionId = data && data.sessionId;
    if (!sessionId) throw new ApiError('创建任务失败：服务端未返回会话 ID');
    S.ui.sheet = null;
    renderSheet();
    navigate('#/chat/' + encodeURIComponent(sessionId));
    const chat = makeChat(sessionId);
    chat.focusComposer = true;
    S.chat = chat;
    if (S.route.name === 'chat') openChat(sessionId);
  } catch (error) {
    if (isAuthError(error)) return handleAuthError(error);
    sheet.creating = false;
    sheet.error = error.message || '创建失败';
    renderSheet();
    toast('创建任务失败：' + (error.message || '未知错误'));
  }
}

async function refreshTasks() {
  if (S.tasks.refreshing) return;
  S.tasks.refreshing = true;
  updateTasksToolbar();
  clearTimeout(S.tasks.refreshTimer);

  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    clearTimeout(S.tasks.refreshTimer);
    S.tasks.refreshing = false;
    updateTasksToolbar();
  };

  const viaHttp = async () => {
    try {
      const data = await net.request('/api/bootstrap');
      applyBootstrap(data);
      if (S.route.name === 'tasks') refreshTasksView();
    } catch (error) {
      if (isAuthError(error)) {
        finish();
        return handleAuthError(error);
      }
      toast('刷新失败：' + error.message);
    } finally {
      finish();
    }
  };

  if (socket && socket.isOpen()) {
    wsSend({ type: 'list' });
    S.tasks.refreshTimer = setTimeout(() => {
      if (S.tasks.refreshing) void viaHttp();
    }, 2500);
  } else {
    await viaHttp();
  }
}

async function retryBootstrap() {
  S.auth = 'pending';
  S.tasks.loading = true;
  S.tasks.error = null;
  renderApp();
  try {
    const data = await net.request('/api/bootstrap');
    applyBootstrap(data);
    S.auth = 'ready';
    if (!socket) connectSocket();
    handleRoute();
  } catch (error) {
    if (isAuthError(error)) return handleAuthError(error);
    S.auth = 'ready';
    S.tasks.loading = false;
    S.tasks.error = error.message || '无法连接电脑端';
    renderApp();
    if (!socket) connectSocket();
  }
}

/* ------------------------------------------------------------------ */
/* 16. 搜索                                                            */
/* ------------------------------------------------------------------ */

function scheduleSearch() {
  clearTimeout(S.tasks.searchTimer);
  const query = S.tasks.query.trim();
  if (!query) {
    S.tasks.results = null;
    S.tasks.searching = false;
    S.tasks.searchError = null;
    S.tasks.searchMode = 'content';
    updateTasksContent();
    return;
  }
  S.tasks.searching = true;
  S.tasks.searchError = null;
  updateTasksContent();
  S.tasks.searchTimer = setTimeout(() => {
    runSearch(query);
  }, 260);
}

async function runSearch(query) {
  try {
    const data = await net.request('/api/search?q=' + encodeURIComponent(query));
    if (S.tasks.query.trim() !== query) return;
    S.tasks.results = data && Array.isArray(data.items) ? data.items : [];
    S.tasks.searchMode = data && data.mode === 'title' ? 'title' : 'content';
    S.tasks.searchError = null;
  } catch (error) {
    if (isAuthError(error)) return handleAuthError(error);
    if (S.tasks.query.trim() !== query) return;
    S.tasks.results = null;
    S.tasks.searchError = error.message || '搜索失败';
  } finally {
    if (S.tasks.query.trim() === query) {
      S.tasks.searching = false;
      updateTasksContent();
    }
  }
}

function toggleSearch() {
  S.tasks.searchOpen = !S.tasks.searchOpen;
  if (!S.tasks.searchOpen) {
    clearSearchState();
  } else {
    renderTasks();
    setTimeout(() => {
      const input = document.getElementById('task-search-input');
      if (input) {
        try {
          input.focus();
        } catch (error) {
          /* ignore */
        }
      }
    }, 60);
    return;
  }
  renderTasks();
}

function clearSearchState() {
  S.tasks.query = '';
  S.tasks.results = null;
  S.tasks.searching = false;
  S.tasks.searchError = null;
  S.tasks.searchMode = 'content';
  clearTimeout(S.tasks.searchTimer);
}

function cancelSearch() {
  clearSearchState();
  S.tasks.searchOpen = false;
  renderTasks();
}

/* ------------------------------------------------------------------ */
/* 17. 变更文件 / diff                                                 */
/* ------------------------------------------------------------------ */

async function toggleChangeFile(turn, index, seq) {
  const chat = S.chat;
  if (!chat || !Number.isFinite(turn) || !Number.isFinite(index)) return;
  const key = turn + ':' + index;

  if (chat.expandedChanges.has(key)) {
    chat.expandedChanges.delete(key);
    renderMessages();
    return;
  }

  chat.expandedChanges.add(key);
  renderMessages();

  if (!Number.isFinite(seq)) return;
  const diffKey = seq + ':' + index;
  if (Object.prototype.hasOwnProperty.call(chat.diffs, diffKey)) return;

  chat.diffs[diffKey] = 'loading';
  renderMessages({ keepScroll: true });

  try {
    const data = await net.request('/api/sessions/' + encodeURIComponent(chat.sessionId) + '/changes/' + seq + '/' + index);
    if (S.chat !== chat) return;
    chat.diffs[diffKey] = data && data.diff ? data.diff : null;
  } catch (error) {
    if (isAuthError(error)) return handleAuthError(error);
    chat.diffs[diffKey] = 'error';
    toast('加载 diff 失败：' + error.message);
  }
  renderMessages();
}

/* ------------------------------------------------------------------ */
/* 18. 事件分发                                                        */
/* ------------------------------------------------------------------ */

function handleAction(action, element, event) {
  switch (action) {
    case 'close-sheet': {
      // 只有点击遮罩空白处或关闭按钮才关闭；点击 sheet 内部空白不关闭
      if (element.classList.contains('sheet-backdrop') && event && event.target !== element && event.target.closest && event.target.closest('.sheet')) return;
      closeSheet();
      return;
    }
    case 'reload-page':
      location.reload();
      return;
    case 'toggle-search':
      toggleSearch();
      return;
    case 'cancel-search':
      cancelSearch();
      return;
    case 'refresh-tasks':
      void refreshTasks();
      return;
    case 'open-filter-sheet':
      openSheet({ type: 'filter' });
      return;
    case 'clear-filter':
      S.tasks.onlyRunning = false;
      updateTasksContent();
      return;
    case 'toggle-only-running':
      S.tasks.onlyRunning = !S.tasks.onlyRunning;
      updateTasksContent();
      renderSheet();
      return;
    case 'new-task':
      void newTask();
      return;
    case 'conn-info':
      openSheet({ type: 'info' });
      return;
    case 'open-session':
      clearSearchState();
      S.tasks.searchOpen = false;
      navigate('#/chat/' + encodeURIComponent(element.getAttribute('data-id') || ''));
      return;
    case 'retry-bootstrap':
      void retryBootstrap();
      return;
    case 'retry-search':
      if (S.tasks.query.trim()) void runSearch(S.tasks.query.trim());
      return;
    case 'chat-back':
    case 'chat-to-list':
      closeSheet();
      navigate('#/');
      return;
    case 'chat-menu':
      openSheet({ type: 'menu' });
      return;
    case 'workspace-info':
      openSheet({ type: 'workspace-info' });
      return;
    case 'chat-new-task':
      void newTask();
      return;
    case 'refresh-session':
      closeSheet();
      if (S.chat) {
        void loadSessionViaHttp(S.chat.sessionId);
        toast('已刷新会话');
      }
      return;
    case 'copy-session-id':
      if (S.chat) void copyText(S.chat.sessionId);
      return;
    case 'copy-workspace-path':
      void copyText(element.getAttribute('data-path') || '');
      return;
    case 'open-model-settings':
      closeSheet();
      navigate('#/models');
      return;
    case 'toggle-turn-process': {
      const chat = S.chat;
      const key = element.getAttribute('data-turn-key');
      if (!chat || !key) return;
      if (chat.expandedTurns.has(key)) chat.expandedTurns.delete(key);
      else chat.expandedTurns.add(key);
      renderMessages();
      return;
    }
    case 'toggle-process-group': {
      const chat = S.chat;
      const groupKey = element.getAttribute('data-group-key');
      if (!chat || !groupKey) return;
      if (chat.expandedProcessGroups.has(groupKey)) chat.expandedProcessGroups.delete(groupKey);
      else chat.expandedProcessGroups.add(groupKey);
      renderMessages();
      return;
    }
    case 'toggle-reasoning': {
      const key = element.getAttribute('data-key');
      const chat = S.chat;
      if (!chat || !key) return;
      if (chat.expandedReasoning.has(key)) chat.expandedReasoning.delete(key);
      else chat.expandedReasoning.add(key);
      renderMessages();
      return;
    }
    case 'toggle-tool': {
      const key = element.getAttribute('data-key');
      const chat = S.chat;
      if (!chat || !key) return;
      if (chat.expandedTools.has(key)) chat.expandedTools.delete(key);
      else chat.expandedTools.add(key);
      renderMessages();
      return;
    }
    case 'toggle-change-file': {
      const turn = Number(element.getAttribute('data-turn'));
      const index = Number(element.getAttribute('data-index'));
      const seqAttr = element.getAttribute('data-seq');
      const seq = seqAttr === null || seqAttr === '' ? NaN : Number(seqAttr);
      void toggleChangeFile(turn, index, seq);
      return;
    }
    case 'copy-turn': {
      const chat = S.chat;
      if (!chat) return;
      const group = findTurnGroup(chat, element.getAttribute('data-group'));
      if (group) void copyText(turnText(group) || '（本回合没有文本内容）');
      return;
    }
    case 'feedback-turn': {
      const chat = S.chat;
      if (!chat) return;
      const groupKey = element.getAttribute('data-group');
      if (!groupKey) return;
      const vote = element.getAttribute('data-vote');
      const key = 'turn:' + groupKey;
      chat.feedback[key] = chat.feedback[key] === vote ? '' : vote;
      renderMessages();
      return;
    }
    case 'retry-turn': {
      const chat = S.chat;
      if (!chat) return;
      const group = findTurnGroup(chat, element.getAttribute('data-group'));
      if (!group || !group.messages.length) return;
      const last = group.messages[group.messages.length - 1];
      resendBefore(last.id);
      return;
    }
    case 'copy-message': {
      const chat = S.chat;
      const messageId = element.getAttribute('data-mid');
      const message = chat && chat.messages.find((item) => item.id === messageId);
      if (message) void copyText(messageText(message) || '（这条消息没有文本内容）');
      return;
    }
    case 'feedback': {
      const chat = S.chat;
      if (!chat) return;
      const messageId = element.getAttribute('data-mid');
      const vote = element.getAttribute('data-vote');
      chat.feedback[messageId] = chat.feedback[messageId] === vote ? '' : vote;
      renderMessages();
      return;
    }
    case 'retry-message':
      resendBefore(element.getAttribute('data-mid'));
      return;
    case 'send':
      if (S.chat && S.chat.running) cancelRun();
      else void sendCurrentPrompt();
      return;
    case 'attach':
      openSheet({ type: 'attach' });
      return;
    case 'pick-image': {
      const source = element.getAttribute('data-source');
      closeSheet();
      const input = document.getElementById(source === 'camera' ? 'image-camera-input' : 'image-album-input');
      if (input) input.click();
      return;
    }
    case 'remove-attachment':
      removeAttachment(element.getAttribute('data-att-id'));
      return;
    case 'jump-bottom':
      scrollToBottom();
      return;
    case 'open-model-sheet':
      void openModelSheet();
      return;
    case 'select-model-row':
      selectModelRow(element);
      return;
    case 'select-effort':
      chooseModel(element.getAttribute('data-provider'), element.getAttribute('data-model'), element.getAttribute('data-effort'));
      return;
    case 'settings-back':
      navigate(S.settings.returnHash || '#/');
      return;
    case 'refresh-models':
      void refreshModels(false);
      return;
    case 'select-provider':
      S.settings.selected = element.getAttribute('data-id');
      renderSettings();
      return;
    case 'select-setting-model':
      chooseModel(element.getAttribute('data-provider'), element.getAttribute('data-model'), null);
      return;
    case 'create-workspace':
      void createInWorkspace(element.getAttribute('data-id'));
      return;
    case 'reload-workspaces':
      void newTask();
      return;
    case 'retry-chat':
      if (S.chat) {
        if (socket && socket.isOpen()) wsSend({ type: 'open', sessionId: S.chat.sessionId });
        else void loadSessionViaHttp(S.chat.sessionId);
      }
      return;
    default:
      return;
  }
}

function bindGlobalEvents() {
  window.addEventListener('online', () => {
    S.offline = false;
    updateBanner();
    if (S.auth === 'ready') {
      wsSend({ type: 'list' });
      if (socket === null) connectSocket();
    }
  });
  window.addEventListener('offline', () => {
    S.offline = true;
    updateBanner();
  });
  document.addEventListener('click', (event) => {
    const origin = event.target;
    if (!origin || !origin.closest) return;
    const target = origin.closest('[data-action]');
    if (!target) return;
    const action = target.getAttribute('data-action');
    if (!action) return;
    try {
      handleAction(action, target, event);
    } catch (error) {
      console.error(error);
    }
  });

  document.addEventListener('input', (event) => {
    const target = event.target;
    if (!target || !target.id) return;
    if (target.id === 'task-search-input') {
      S.tasks.query = target.value;
      scheduleSearch();
    } else if (target.id === 'composer-input') {
      if (!S.chat) return;
      S.chat.draft = target.value;
      autoGrowComposer(target);
      updateSendButton();
    }
  });

  document.addEventListener('keydown', (event) => {
    const target = event.target;
    if (!target || !target.id) return;
    if (target.id === 'task-search-input' && event.key === 'Escape') {
      event.preventDefault();
      cancelSearch();
      return;
    }
    if (target.id === 'composer-input' && event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      if (S.chat && S.chat.running) return;
      sendPrompt();
    }
  });

  window.addEventListener('hashchange', handleRoute);
  window.addEventListener('resize', () => updateJumpButton());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || S.auth !== 'ready') return;
    if (!socket || !socket.isOpen()) connectSocket();
  });
  window.addEventListener('beforeunload', () => {
    if (socket) socket.close();
  });
}

/* ------------------------------------------------------------------ */
/* 19. 启动                                                            */
/* ------------------------------------------------------------------ */

async function init() {
  initViewport();
  bindGlobalEvents();
  S.token = readToken();

  if (SIMULATE_OFFLINE) {
    // 自检优先：强制网络失败，验证离线缓存首屏（不影响真实模式）
    net = {
      mode: 'offline-sim',
      request: () => Promise.reject(Object.assign(new Error('offline'), { status: 0 })),
    };
  } else if (MOCK) {
    try {
      const mockModule = await import('./mock.js');
      net = mockModule.createMockNet();
    } catch (error) {
      viewRoot.innerHTML = '<div class="state-box">' + svgIcon('alert', 'state-icon') + '<p class="state-title">开发 mock 加载失败</p><p class="state-text">' + escapeHtml(error.message) + '</p></div>';
      return;
    }
  } else if (!S.token) {
    S.auth = 'missing';
    renderApp();
    return;
  } else {
    net = createRealNet(S.token);
  }

  // 先渲染上次的快照：冷启动时不会白屏，随后网络返回再覆盖。
  restoreModelsSnapshot();
  const hadCache = restoreListSnapshot();
  S.auth = 'pending';
  S.offline = false;
  renderApp();

  try {
    const bootstrap = await net.request('/api/bootstrap');
    applyBootstrap(bootstrap);
    S.auth = 'ready';
    S.offline = false;
    connectSocket();
    handleRoute();
  } catch (error) {
    if (isAuthError(error)) {
      handleAuthError(error);
      return;
    }
    const transient = isTransientError(error);
    S.auth = 'ready';
    S.tasks.loading = false;
    S.offline = transient;
    S.tasks.error = transient
      ? (hadCache ? '当前处于离线状态，显示上次同步的内容' : '无法连接电脑端，请确认与电脑在同一局域网')
      : (error.message || '无法连接电脑端');
    renderApp();
    connectSocket();
    handleRoute();
  }
}

/** Network-level failures (offline, DNS, timeout) are recoverable; auth/business errors are not. */
function isTransientError(error) {
  if (!error) return false;
  if (error.status === 0) return true;
  return false;
}

void init();
