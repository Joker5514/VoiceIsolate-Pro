/**
 * True when a key event target takes typed text (so single-letter shortcuts
 * must not fire). Sliders, checkboxes and buttons are not text entry.
 */
const NON_TEXT_INPUTS = new Set(['range', 'checkbox', 'radio', 'button', 'submit', 'reset', 'color', 'file', 'image']);

export function isTextEntry(target) {
  if (!target || typeof target !== 'object') return false;
  if (target.isContentEditable) return true;
  const tag = String(target.tagName || '').toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag !== 'INPUT') return false;
  return !NON_TEXT_INPUTS.has(String(target.type || 'text').toLowerCase());
}
