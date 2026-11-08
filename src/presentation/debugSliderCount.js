/**
 * Count Engineer controls the way the rack mounts them.
 * Registry length is the denominator (67, including Whisper Mode).
 * A control counts when its row or input carries data-slider-id.
 * An empty list is a failure, never a passing 0/0.
 */
export function summarizeSliderMount(doc, registry) {
  const list = Array.isArray(registry) ? registry : [];
  const mounted = new Set();
  const root = doc && typeof doc.querySelectorAll === 'function' ? doc : null;
  if (root) {
    root.querySelectorAll('[data-slider-id]').forEach((el) => {
      const id = el.dataset?.sliderId;
      if (id) mounted.add(id);
    });
  }
  const expected = list.length > 0 ? list.length : null;
  let found = mounted.size;
  if (expected != null) {
    const ids = new Set(list.map((entry) => entry && entry.id).filter(Boolean));
    found = [...mounted].filter((id) => ids.has(id)).length;
  }
  return {
    found,
    expected,
    ok: expected != null && found === expected && expected > 0,
  };
}

export function mountedRangeSliders(doc) {
  if (!doc || typeof doc.querySelectorAll !== 'function') return [];
  return [...doc.querySelectorAll('input[type="range"].dsp-slider, input[type="range"][data-slider-id]')];
}
