/**
 * VoiceIsolate Pro — shared live diagnostics for Stems and Engineer.
 *
 * Ring buffer of timestamped events. Float32 audio and ArrayBuffers are
 * reduced to lengths. The panel is collapsed until opened. Logging must
 * never throw into the audio path.
 */
'use strict';

const MAX_EVENTS = 200;
const LEVELS = new Set(['info', 'warn', 'error']);

/** @type {Array<{ ts: string, level: string, page: string, event: string, detail: object|null }>} */
const _events = [];
const _listeners = new Set();
let _page = 'app';
let _installed = false;
let _seq = 0;

function nowIso() {
  return new Date().toISOString();
}

function sanitize(value, depth = 0) {
  if (value == null) return value;
  if (typeof value === 'string') {
    return value.length > 500 ? `${value.slice(0, 500)}…` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return String(value);
  if (typeof value !== 'object') return String(value);
  if (ArrayBuffer.isView(value)) {
    return { type: value.constructor?.name || 'TypedArray', length: value.length };
  }
  if (value instanceof ArrayBuffer) return { type: 'ArrayBuffer', byteLength: value.byteLength };
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack || null };
  }
  if (depth >= 3) return '[object]';
  if (Array.isArray(value)) {
    // A plain number list is how PCM shows up when it is not a typed array.
    if (value.length > 16 && value.every((item) => typeof item === 'number')) {
      return { type: 'number[]', length: value.length };
    }
    return value.slice(0, 12).map((item) => sanitize(item, depth + 1));
  }
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (/pcm|channelData|samples|audioData/i.test(key) && item && typeof item === 'object') {
      out[key] = ArrayBuffer.isView(item)
        ? { type: item.constructor?.name || 'TypedArray', length: item.length }
        : '[redacted]';
      continue;
    }
    out[key] = sanitize(item, depth + 1);
  }
  return out;
}

function memoryEstimate() {
  try {
    const mem = globalThis.performance?.memory;
    if (!mem) return null;
    return {
      usedJsHeapSize: mem.usedJsHeapSize,
      totalJsHeapSize: mem.totalJsHeapSize,
      jsHeapSizeLimit: mem.jsHeapSizeLimit,
    };
  } catch {
    return null;
  }
}

function emit(entry) {
  _events.push(entry);
  if (_events.length > MAX_EVENTS) _events.shift();
  for (const fn of _listeners) {
    try { fn(entry); } catch { /* a panel must not break the publisher */ }
  }
}

/**
 * @param {'info'|'warn'|'error'} level
 * @param {string} event
 * @param {object} [detail]
 * @param {{ includeMemory?: boolean, page?: string }} [options]
 */
export function vipLog(level, event, detail = null, options = {}) {
  try {
    const normalized = LEVELS.has(level) ? level : 'info';
    const payload = detail && typeof detail === 'object' ? sanitize(detail) : (detail == null ? null : { value: sanitize(detail) });
    if (options.includeMemory) {
      const memory = memoryEstimate();
      if (memory && payload && typeof payload === 'object' && !Array.isArray(payload)) payload.memory = memory;
    }
    emit({
      id: ++_seq,
      ts: nowIso(),
      level: normalized,
      page: options.page || _page,
      event: String(event || 'event').slice(0, 120),
      detail: payload,
    });
  } catch {
    /* diagnostics are best-effort */
  }
}

export function getLiveDiagnostics() {
  return _events.map((entry) => ({ ...entry }));
}

export function clearLiveDiagnostics() {
  _events.length = 0;
  for (const fn of _listeners) {
    try { fn(null); } catch { /* ignore */ }
  }
}

export function subscribeLiveDiagnostics(fn) {
  if (typeof fn !== 'function') return () => {};
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

function formatEntry(entry) {
  const detail = entry.detail == null ? '' : ` ${JSON.stringify(entry.detail)}`;
  return `${entry.ts} ${entry.level.toUpperCase()} [${entry.page}] ${entry.event}${detail}`;
}

export async function copyLiveDiagnostics() {
  const text = getLiveDiagnostics().map(formatEntry).join('\n') || '(no diagnostics)';
  try {
    if (globalThis.navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through */ }
  return false;
}

function installGlobalGuards() {
  if (_installed || typeof globalThis.addEventListener !== 'function') return;
  _installed = true;
  globalThis.addEventListener('error', (ev) => {
    vipLog('error', 'window.error', {
      message: ev?.message || 'error',
      filename: ev?.filename || null,
      line: ev?.lineno || null,
      stack: ev?.error?.stack || null,
    });
  });
  globalThis.addEventListener('unhandledrejection', (ev) => {
    const reason = ev?.reason;
    vipLog('error', 'unhandledrejection', reason instanceof Error
      ? { message: reason.message, stack: reason.stack || null }
      : { message: String(reason) });
  });
}

function ensureStyle(doc) {
  if (doc.getElementById('vip-live-diagnostics-style')) return;
  const style = doc.createElement('style');
  style.id = 'vip-live-diagnostics-style';
  style.textContent = [
    '#vip-live-diagnostics{position:fixed;right:12px;bottom:12px;z-index:10000;width:min(420px,calc(100vw - 24px));',
    'font:12px/1.4 ui-monospace,Consolas,monospace;color:#c9d1d9;background:rgba(10,10,15,.94);',
    'border:1px solid rgba(0,212,255,.28);border-radius:8px}',
    // Engineer Console: dock below the sticky header instead of the
    // bottom-right. The bottom-right dock sat over the transport/play
    // controls (.transport-card, pinned to the bottom edge by the
    // workstation shell), and a top:12px dock would cover the header's
    // top-right corner instead. --vip-hdr-h is the header's real rendered
    // height, published on documentElement by engineer-console.js (48px
    // fallback matches the shell's own convention). The rule MUST be a
    // top-level sibling after the base rule's closing '}' — an earlier
    // revision nested it inside the still-open base rule, where it
    // resolved to a descendant selector that never matches and broke the
    // whole stylesheet's parse in jsdom. bottom:auto is required because
    // the base rule sets bottom:12px.
    // Stems page (Landing): same top dock, for the same reason — the
    // bottom-right dock covers the play button in #landingTransport.
    // Landing does NOT publish --vip-hdr-h, so this rule anchors to the
    // real landing header height instead: body.v3 .v3-header is a fixed
    // 52px sticky header (public/landing-v3.css), plus the same 12px gap.
    // Any other page keeps the bottom-right dock.
    '#vip-live-diagnostics[data-page="engineer"]{top:calc(var(--vip-hdr-h, 48px) + 12px);bottom:auto}',
    '#vip-live-diagnostics[data-page="stems"]{top:calc(52px + 12px);bottom:auto}',
    '#vip-live-diagnostics[data-collapsed="true"] .vip-diag-body{display:none}',
    '.vip-diag-bar{display:flex;gap:8px;align-items:center;padding:6px 8px}',
    '.vip-diag-bar button,.vip-diag-tools button{background:transparent;color:#00d4ff;border:1px solid rgba(0,212,255,.35);border-radius:4px;padding:4px 8px;cursor:pointer}',
    '.vip-diag-list{max-height:240px;overflow:auto;margin:0;padding:0 8px 8px;list-style:none}',
    '.vip-diag-list li{border-top:1px solid rgba(255,255,255,.06);padding:4px 0}',
    '.vip-diag-list .warn{color:#f5c16c}.vip-diag-list .error{color:#ff8b8b}',
    '.vip-diag-detail{white-space:pre-wrap;color:#9aa4b2;margin:4px 0 0}',
  ].join('');
  doc.head.appendChild(style);
}

function renderList(list, events) {
  list.replaceChildren();
  for (const entry of events) {
    const item = document.createElement('li');
    item.className = entry.level;
    const summary = document.createElement('div');
    summary.textContent = `${entry.ts.slice(11, 23)} ${entry.level.toUpperCase()} ${entry.event}`;
    item.appendChild(summary);
    if (entry.detail) {
      const pre = document.createElement('pre');
      pre.className = 'vip-diag-detail';
      pre.hidden = true;
      pre.textContent = JSON.stringify(entry.detail, null, 2);
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.textContent = 'Details';
      toggle.addEventListener('click', () => { pre.hidden = !pre.hidden; });
      item.appendChild(toggle);
      item.appendChild(pre);
    }
    list.appendChild(item);
  }
  list.scrollTop = list.scrollHeight;
}

/**
 * Mount the collapsed diagnostics panel. Safe to call again.
 * @param {'stems'|'engineer'|string} page
 */
export function mountLiveDiagnostics(page) {
  if (typeof document === 'undefined') return null;
  _page = page || _page;
  installGlobalGuards();
  ensureStyle(document);
  let root = document.getElementById('vip-live-diagnostics');
  if (root) {
    root.dataset.page = _page;
    return root;
  }
  root = document.createElement('section');
  root.id = 'vip-live-diagnostics';
  root.dataset.page = _page;
  root.dataset.collapsed = 'true';
  root.setAttribute('aria-label', 'Live diagnostics');

  const bar = document.createElement('div');
  bar.className = 'vip-diag-bar';
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.textContent = `Diagnostics · ${_page}`;
  toggle.setAttribute('aria-expanded', 'false');
  toggle.addEventListener('click', () => {
    const collapsed = root.dataset.collapsed !== 'true';
    root.dataset.collapsed = collapsed ? 'true' : 'false';
    toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  });
  bar.appendChild(toggle);

  const body = document.createElement('div');
  body.className = 'vip-diag-body';
  const list = document.createElement('ol');
  list.className = 'vip-diag-list';
  list.setAttribute('role', 'log');
  list.setAttribute('aria-live', 'polite');
  const tools = document.createElement('div');
  tools.className = 'vip-diag-tools';
  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.textContent = 'Copy';
  copyBtn.addEventListener('click', () => { void copyLiveDiagnostics(); });
  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.textContent = 'Clear';
  clearBtn.addEventListener('click', () => { clearLiveDiagnostics(); });
  tools.append(copyBtn, clearBtn);
  body.append(list, tools);
  root.append(bar, body);
  document.body.appendChild(root);

  const paint = () => renderList(list, _events);
  subscribeLiveDiagnostics(paint);
  paint();
  return root;
}

if (typeof globalThis !== 'undefined') {
  globalThis.VIP_liveDiagnostics = {
    log: vipLog,
    mount: mountLiveDiagnostics,
    clear: clearLiveDiagnostics,
    copy: copyLiveDiagnostics,
    get entries() { return getLiveDiagnostics(); },
  };
}

export default {
  vipLog,
  mountLiveDiagnostics,
  getLiveDiagnostics,
  clearLiveDiagnostics,
  copyLiveDiagnostics,
  subscribeLiveDiagnostics,
};
