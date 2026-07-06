'use strict';

/**
 * Shared upload helpers for Landing + Engineer Mode.
 * Opens the native picker inside a user gesture and prefers showPicker()
 * when the browser supports it (more reliable than off-screen input.click()).
 */

/**
 * @param {HTMLInputElement|null|undefined} fileInput
 * @returns {boolean}
 */
export function openFilePicker(fileInput) {
  if (!fileInput || fileInput.disabled) return false;
  if (typeof fileInput.showPicker === 'function') {
    try {
      fileInput.showPicker();
      return true;
    } catch {
      /* fall through to .click() */
    }
  }
  fileInput.click();
  return true;
}

/**
 * Resume/create a throwaway AudioContext inside the current user gesture.
 * Mobile Safari requires this before decodeAudioData will run.
 * @returns {Promise<void>}
 */
export async function primeAudioGesture() {
  const Ctor = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!Ctor) return;
  const ctx = new Ctor();
  try {
    if (ctx.state === 'suspended') await ctx.resume();
  } finally {
    try { await ctx.close(); } catch { /* ignore */ }
  }
}

/**
 * Apply touch/pointer fixes so upload controls stay tappable under slider CSS.
 */
export function fixUploadTouchTargets(root = globalThis.document) {
  if (!root?.querySelectorAll) return;
  const selectors = [
    '#dz', '#dropZone', '.drop-zone', '#uploadZone',
    '#fileBtn', '#browseBtn', 'input[type="file"]',
  ];
  for (const sel of selectors) {
    root.querySelectorAll(sel).forEach((el) => {
      el.style.touchAction = 'auto';
      el.style.pointerEvents = 'auto';
      el.style.webkitUserSelect = 'auto';
      el.style.userSelect = 'auto';
    });
  }
}

export default { openFilePicker, primeAudioGesture, fixUploadTouchTargets };