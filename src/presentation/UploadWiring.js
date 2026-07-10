'use strict';

/**
 * Shared upload helpers for Landing + Engineer Mode.
 * Opens the native picker inside a user gesture. Chromium 120+ blocks
 * programmatic .click() on file inputs positioned far off-screen — we keep
 * the input in the viewport (still invisible) for the duration of the click.
 */

/**
 * @param {HTMLInputElement|null|undefined} fileInput
 * @returns {boolean}
 */
export function openFilePicker(fileInput) {
  if (!fileInput || fileInput.disabled) return false;

  const style = fileInput.style;
  const prev = {
    position: style.position,
    left: style.left,
    top: style.top,
    width: style.width,
    height: style.height,
    opacity: style.opacity,
    overflow: style.overflow,
    pointerEvents: style.pointerEvents,
    zIndex: style.zIndex,
  };

  Object.assign(style, {
    position: 'fixed',
    left: '0',
    top: '0',
    width: '1px',
    height: '1px',
    opacity: '0.001',
    overflow: 'hidden',
    pointerEvents: 'auto',
    zIndex: '2147483646',
  });

  let opened = false;
  try {
    fileInput.click();
    opened = true;
  } catch {
    if (typeof fileInput.showPicker === 'function') {
      try {
        fileInput.showPicker();
        opened = true;
      } catch {
        /* both paths failed */
      }
    }
  } finally {
    const restore = () => {
      style.position = prev.position;
      style.left = prev.left;
      style.top = prev.top;
      style.width = prev.width;
      style.height = prev.height;
      style.opacity = prev.opacity;
      style.overflow = prev.overflow;
      style.pointerEvents = prev.pointerEvents;
      style.zIndex = prev.zIndex;
    };
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(restore);
    } else {
      restore();
    }
  }

  return opened;
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
    '#fileBtn', '#browseBtn', 'label[for="fileInput"]',
    'input[type="file"]',
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