/**
 * Landing transport keyboard policy.
 * Space and K start or pause playback. Text fields, contenteditable, and a
 * focused button keep their own keys. Arrow keys scrub.
 */

const TEXT_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

/**
 * @param {{
 *   key?: string,
 *   ctrlKey?: boolean,
 *   metaKey?: boolean,
 *   altKey?: boolean,
 *   defaultPrevented?: boolean,
 *   target?: { tagName?: string, isContentEditable?: boolean, closest?: Function } | null,
 * }} event
 * @returns {'play'|'seek-back'|'seek-forward'|null}
 */
export function transportKeyAction(event) {
  if (!event || event.defaultPrevented) return null;
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  const target = event.target;
  if (!target) return null;
  const tag = target.tagName || '';
  if (TEXT_TAGS.has(tag) || target.isContentEditable) return null;
  if (tag === 'BUTTON') return null;
  if (typeof target.closest === 'function' && target.closest('[role="tablist"]')) return null;
  if (event.key === ' ' || event.key === 'k' || event.key === 'K') return 'play';
  if (event.key === 'ArrowLeft') return 'seek-back';
  if (event.key === 'ArrowRight') return 'seek-forward';
  return null;
}
