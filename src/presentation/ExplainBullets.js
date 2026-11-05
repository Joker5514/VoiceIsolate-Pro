/**
 * Compact clickable explanations. The question stays visible. The answer
 * opens underneath. Status, errors, and the waveform are not folded here.
 */
'use strict';

const STORAGE_KEY = 'vip.explain.open.v1';

function readOpen() {
  try {
    if (typeof localStorage === 'undefined') return {};
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') || {};
  } catch {
    return {};
  }
}

function writeOpen(state) {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch { /* private mode */ }
}

export function mountExplainBullets(root, items) {
  if (!root || !items?.length) return null;
  const state = readOpen();
  const list = document.createElement('div');
  list.className = 'vip-explain';
  items.forEach((item, index) => {
    const id = item.id || `vip-explain-${index}`;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'vip-explain__q';
    btn.textContent = item.q;
    const panel = document.createElement('div');
    panel.className = 'vip-explain__a';
    panel.id = `${id}-panel`;
    panel.textContent = item.a;
    btn.setAttribute('aria-controls', panel.id);
    const open = state[id] === true;
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    panel.hidden = !open;
    btn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const next = btn.getAttribute('aria-expanded') !== 'true';
      btn.setAttribute('aria-expanded', String(next));
      panel.hidden = !next;
      state[id] = next;
      writeOpen(state);
    });
    list.append(btn, panel);
  });
  root.append(list);
  return list;
}

/** Hide a standing paragraph and put its text behind one question. */
export function foldParagraph(node, question, id) {
  if (!node || node.dataset.explainFolded === '1') return;
  const text = (node.textContent || '').trim();
  if (!text) return;
  node.dataset.explainFolded = '1';
  node.hidden = true;
  const host = document.createElement('div');
  node.after(host);
  mountExplainBullets(host, [{ id: id || node.id || question, q: question, a: text }]);
}

export const INGESTION_EXPLAINS = Object.freeze([
  {
    id: 'why-chunked',
    q: 'Why is chunked processing being used?',
    a: 'The full recording would need more working memory than this device can safely allocate. VoiceIsolate keeps the source file and processes overlapping windows that fit the current memory profile.',
  },
  {
    id: 'why-budget',
    q: 'What does the memory budget mean?',
    a: 'The budget is a planning limit for decoded audio and model windows. It is not free RAM, not storage space, and not the model download size. AUTO picks the device tier. LOW, BALANCED, and HIGH change the window length inside that limit.',
  },
  {
    id: 'why-48k',
    q: 'Why does this model use 48 kHz?',
    a: 'The standard local model, bsrnn_vocals, was exported for 48 kHz spectral frames. Other models keep their own rate. A file is not resampled just because one model uses 48 kHz, and it is not resampled to squeeze a long file into memory.',
  },
  {
    id: 'why-source',
    q: 'How is the original recording protected?',
    a: 'The source file is only read. Working audio is a separate buffer or a new WAV. Nothing is written back into the file you imported.',
  },
  {
    id: 'why-segment',
    q: 'What happens if a processing segment fails?',
    a: 'That segment is marked failed and the partial output is discarded. The app does not present a short or broken file as a finished extract.',
  },
]);
