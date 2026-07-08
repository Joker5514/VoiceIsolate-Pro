/**
 * Loop + crop transport controls shared by landing and engineer surfaces.
 */
'use strict';

/**
 * @param {object} opts
 * @param {{ setLoop: Function, isLoopEnabled: Function, markCropIn: Function, markCropOut: Function, clearCrop: Function, getCropRegion: Function, hasCrop: Function, duration: Function }} opts.mixer
 * @param {HTMLElement} [opts.loopBtn]
 * @param {HTMLElement} [opts.cropInBtn]
 * @param {HTMLElement} [opts.cropOutBtn]
 * @param {HTMLElement} [opts.cropClearBtn]
 * @param {HTMLElement} [opts.seekEl] range input for --seek-pct / crop markers
 * @param {HTMLElement} [opts.regionBar] overlay bar for crop shading
 * @param {(region: {in:number,out:number}) => void} [opts.onChange]
 */
export function wireTransportRegion(opts) {
  const mixer = opts.mixer;
  if (!mixer) return () => {};

  const syncUi = () => {
    const dur = mixer.duration() || 0;
    const region = mixer.getCropRegion();
    if (opts.loopBtn) {
      const on = mixer.isLoopEnabled();
      opts.loopBtn.classList.toggle('is-active', on);
      opts.loopBtn.setAttribute('aria-pressed', String(on));
    }
    if (dur > 0 && opts.seekEl) {
      const inPct = (region.in / dur) * 100;
      const outPct = (region.out / dur) * 100;
      opts.seekEl.style.setProperty('--crop-in-pct', `${inPct}%`);
      opts.seekEl.style.setProperty('--crop-out-pct', `${outPct}%`);
    }
    if (opts.regionBar && dur > 0) {
      const inPct = (region.in / dur) * 100;
      const outPct = (region.out / dur) * 100;
      opts.regionBar.style.setProperty('--crop-in-pct', `${inPct}%`);
      opts.regionBar.style.setProperty('--crop-out-pct', `${outPct}%`);
      opts.regionBar.hidden = !mixer.hasCrop();
    }
    opts.onChange?.(region);
  };

  opts.loopBtn?.addEventListener('click', () => {
    mixer.setLoop(!mixer.isLoopEnabled());
    syncUi();
  });
  opts.cropInBtn?.addEventListener('click', () => {
    mixer.markCropIn();
    syncUi();
  });
  opts.cropOutBtn?.addEventListener('click', () => {
    mixer.markCropOut();
    syncUi();
  });
  opts.cropClearBtn?.addEventListener('click', () => {
    mixer.clearCrop();
    syncUi();
  });

  syncUi();
  return syncUi;
}

/** Paint --seek-pct on a transport range input from current/duration. */
export function paintSeekFill(seekEl, current, duration) {
  if (!seekEl || !duration) return;
  const pct = Math.max(0, Math.min(100, (current / duration) * 100));
  seekEl.style.setProperty('--seek-pct', `${pct}%`);
}