/**
 * Keep a slider hint meter's accessible description aligned with the live value.
 * The hint body stays static; only the range meter label and thumb move.
 */
export function updateHintPanelValue(panel, { min, max, value, unit = '' } = {}) {
  if (!panel || typeof panel.querySelector !== 'function') return false;
  const meter = panel.querySelector('.hint-range-meter');
  if (!meter) return false;
  const lo = Number(min);
  const hi = Number(max);
  const current = Number(value);
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || !Number.isFinite(current)) return false;
  const pct = hi > lo ? Math.max(0, Math.min(100, ((current - lo) / (hi - lo)) * 100)) : 50;
  const suffix = unit == null ? '' : String(unit);
  meter.setAttribute('aria-label', `Range ${lo}${suffix} to ${hi}${suffix}, current ${current}${suffix}`);
  const thumb = meter.querySelector('.hint-range-thumb');
  if (thumb && thumb.style) thumb.style.left = `${pct.toFixed(1)}%`;
  return true;
}
