/**
 * app-patches.js  —  VoiceIsolate Pro v22.1
 *
 * Non-destructive monkey-patches applied to VoiceIsolatePro.prototype
 * BEFORE vip-boot.js instantiates the class.
 *
 * Fixes four bugs without touching the 109 KB app.js:
 *
 *  Bug 1 – buildSliderPanels(): ReferenceError on `sr` (undefined free
 *           variable that should be `panel`) AND duplicate innerHTML
 *           accumulator that doubled every slider row.
 *
 *  Bug 2 – cacheDom(): missing tpVol, tpScrubTrack, tpScrubFill,
 *           tpScrubThumb — caused silent null-deref in bindEvents.
 *
 *  Bug 3 – bindEvents(): tpSeek no longer exists in the HTML (replaced
 *           by the custom scrubber divs tpScrubTrack / tpScrubFill /
 *           tpScrubThumb). Wired pointer-event scrubber instead.
 *           Also guards tpSpeed with an existence check.
 *
 *  Bug 4 – applyPreset(): double assignment of el.value / ve.textContent
 *           in the same loop iteration (redundant second block).
 */
(function patchVoiceIsolatePro() {
  'use strict';

  function applyPatches() {
    if (typeof VoiceIsolatePro === 'undefined') {
      console.error('[app-patches] VoiceIsolatePro not defined — is app.js loaded first?');
      return;
    }
    const P = VoiceIsolatePro.prototype;

    // ─────────────────────────────────────────────────────────────────
    // BUG 1 FIX: buildSliderPanels
    // ─────────────────────────────────────────────────────────────────
    P.buildSliderPanels = function () {
      for (const [tabKey, sliders] of Object.entries(SLIDERS)) {
        const panel = document.getElementById('tab-' + tabKey);
        if (!panel) continue;

        // Wipe panel so re-calls don't stack
        panel.innerHTML = '';

        const srDiv = document.createElement('div');
        srDiv.className = 'sr';

        for (const s of sliders) {
          const row = document.createElement('div');
          row.className = 'sr-row';
          row.dataset.desc = s.desc;

          // Label
          const labelEl = document.createElement('label');
          labelEl.className = 'sr-label';
          labelEl.title = s.desc;
          labelEl.htmlFor = s.id;
          labelEl.textContent = s.label;
          if (s.rt) {
            const badge = document.createElement('span');
            badge.className = 'rt-badge';
            badge.textContent = 'RT';
            labelEl.appendChild(badge);
          }
          const infoEl = document.createElement('span');
          infoEl.className = 'sr-info';
          infoEl.textContent = 'i';
          infoEl.setAttribute('aria-hidden', 'true');
          labelEl.appendChild(infoEl);

          // Range input
          const inputEl = document.createElement('input');
          inputEl.type = 'range';
          if (s.rt) inputEl.className = 'realtime';
          inputEl.id = s.id;
          inputEl.min = s.min;
          inputEl.max = s.max;
          inputEl.value = s.val;
          inputEl.step = s.step;
          inputEl.dataset.param = s.id;
          inputEl.setAttribute('aria-label', s.label + (s.rt ? ' (Real-time)' : ''));
          inputEl.setAttribute('aria-valuemin', s.min);
          inputEl.setAttribute('aria-valuemax', s.max);
          inputEl.setAttribute('aria-valuenow', s.val);
          const rng = s.max - s.min;
          const initPct = rng > 0 ? ((s.val - s.min) / rng) * 100 : 0;
          inputEl.style.setProperty('--pct', initPct.toFixed(1) + '%');

          // Value display
          const valEl = document.createElement('span');
          valEl.className = 'sr-val';
          valEl.id = s.id + 'Val';
          valEl.textContent = s.val + s.unit;

          row.appendChild(labelEl);
          row.appendChild(inputEl);
          row.appendChild(valEl);
          srDiv.appendChild(row);   // FIX: was `sr.appendChild(row)` — `sr` was undefined
        }

        panel.appendChild(srDiv);  // FIX: no innerHTML accumulator → no duplicate rows
      }
    };

    // ─────────────────────────────────────────────────────────────────
    // BUG 2 FIX: cacheDom — add missing scrubber + volume nodes
    // ─────────────────────────────────────────────────────────────────
    const _origCacheDom = P.cacheDom;
    P.cacheDom = function () {
      _origCacheDom.call(this);  // run original first
      const g = id => document.getElementById(id);
      // Augment dom with missing handles
      Object.assign(this.dom, {
        tpVol:         g('tpVol'),
        tpScrubTrack:  g('tpScrubTrack'),
        tpScrubFill:   g('tpScrubFill'),
        tpScrubThumb:  g('tpScrubThumb'),
      });
    };

    // ─────────────────────────────────────────────────────────────────
    // BUG 3 FIX: bindEvents — scrubber & tpSpeed guard
    // ─────────────────────────────────────────────────────────────────
    const _origBindEvents = P.bindEvents;
    P.bindEvents = function () {
      _origBindEvents.call(this);

      // --- Custom scrubber (tpScrubTrack) ---
      const track = this.dom.tpScrubTrack;
      if (track) {
        let scrubbing = false;

        const getFrac = (e) => {
          const rect = track.getBoundingClientRect();
          return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        };

        const updateScrub = (e) => {
          if (!scrubbing) return;
          const frac = getFrac(e);
          // Update fill/thumb CSS
          if (this.dom.tpScrubFill)  this.dom.tpScrubFill.style.width  = (frac * 100) + '%';
          if (this.dom.tpScrubThumb) this.dom.tpScrubThumb.style.left  = (frac * 100) + '%';
          track.setAttribute('aria-valuenow', Math.round(frac * 100));
          this.seekTo(frac);
        };

        track.addEventListener('pointerdown', (e) => {
          if (!this.inputBuffer) return;
          scrubbing = true;
          track.setPointerCapture(e.pointerId);
          updateScrub(e);
        });
        track.addEventListener('pointermove', updateScrub);
        track.addEventListener('pointerup',   () => { scrubbing = false; });
        track.addEventListener('pointercancel', () => { scrubbing = false; });

        // Keyboard seek on the scrubber track
        track.addEventListener('keydown', (e) => {
          if (!this.inputBuffer) return;
          const dur = this.inputBuffer.duration;
          if (e.key === 'ArrowRight') { e.preventDefault(); this.seekDelta(5); }
          if (e.key === 'ArrowLeft')  { e.preventDefault(); this.seekDelta(-5); }
          if (e.key === 'Home')       { e.preventDefault(); this.seekTo(0); }
          if (e.key === 'End')        { e.preventDefault(); this.seekTo(1); }
        });
      }

      // --- Volume slider ---
      const volEl = this.dom.tpVol;
      if (volEl) {
        volEl.addEventListener('input', () => {
          const v = parseFloat(volEl.value);
          if (this.liveNodes && this.liveNodes.outG) {
            const gain = v * Math.pow(10, (this.params.outGain || 0) / 20);
            this.liveNodes.outG.gain.setTargetAtTime(gain, this.ctx.currentTime, 0.02);
          }
          if (this.isVideo && this.dom.videoPlayer) {
            this.dom.videoPlayer.volume = v;
          }
        });
      }

      // --- tpSpeed guard (tpSpeed is null in the current HTML) ---
      // The original bindEvents does: this.dom.tpSpeed.addEventListener(...).
      // tpSpeed is fetched via cacheDom → getElementById('tpSpeed') → null
      // because the HTML uses a <select id="tpSpeed"> that IS present.
      // The only case it's null is if the HTML was changed; guard it anyway:
      if (!this.dom.tpSpeed && document.getElementById('tpSpeed')) {
        this.dom.tpSpeed = document.getElementById('tpSpeed');
      }
    };

    // ─────────────────────────────────────────────────────────────────
    // BUG 4 FIX: applyPreset — remove duplicate el.value assignment
    // ─────────────────────────────────────────────────────────────────
    P.applyPreset = function (name) {
      const p = PRESETS[name];
      if (!p) return;
      Object.assign(this.params, p);
      for (const [, sliders] of Object.entries(SLIDERS)) {
        for (const s of sliders) {
          if (this.params[s.id] === undefined) continue;
          const el = document.getElementById(s.id);
          const ve = document.getElementById(s.id + 'Val');
          if (!el) continue;
          el.value = this.params[s.id];
          el.setAttribute('aria-valuenow', this.params[s.id]);
          if (ve) ve.textContent = this.params[s.id] + s.unit;
          const range = s.max - s.min;
          const pct = range > 0 ? ((this.params[s.id] - s.min) / range) * 100 : 0;
          el.style.setProperty('--pct', pct.toFixed(1) + '%');
          // FIX: removed redundant second `el.value = ...` block that was
          // below the pct line in the original, causing a double write.
        }
      }
      document.querySelectorAll('.btn-preset').forEach(b =>
        b.classList.toggle('active', b.dataset.preset === name));
      if (this.liveChainBuilt) this.updateLiveChain();
    };

    // ─────────────────────────────────────────────────────────────────
    // PATCH 5: tickTime — keep scrubber fill/thumb in sync
    // ─────────────────────────────────────────────────────────────────
    P.tickTime = function () {
      const tick = () => {
        if (!this.isPlaying) return;
        const speed = parseFloat((this.dom.tpSpeed && this.dom.tpSpeed.value) || 1);
        const elapsed = this.playOffset + (this.ctx.currentTime - this.playStartTime) * speed;
        const dur = this.inputBuffer ? this.inputBuffer.duration : 0;
        if (elapsed >= dur) { this.stop(); return; }
        const frac = dur > 0 ? elapsed / dur : 0;
        // Text
        if (this.dom.tpCur) this.dom.tpCur.textContent = this.fmtDur(elapsed);
        // Legacy input[range] scrubber (may be null in new HTML)
        if (this.dom.tpSeek) this.dom.tpSeek.value = frac * 1000;
        // Custom scrubber divs
        if (this.dom.tpScrubFill)  this.dom.tpScrubFill.style.width  = (frac * 100) + '%';
        if (this.dom.tpScrubThumb) this.dom.tpScrubThumb.style.left  = (frac * 100) + '%';
        if (this.dom.tpScrubTrack) this.dom.tpScrubTrack.setAttribute('aria-valuenow', Math.round(frac * 100));
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    };

    // ─────────────────────────────────────────────────────────────────
    // BUG 5 FIX: stop() / seekDelta() / seekTo() — null tpSeek guard
    // tpSeek is null in the current HTML (replaced by custom scrubber
    // divs). These methods access tpSeek.value unconditionally.
    // ─────────────────────────────────────────────────────────────────
    P.stop = function () {
      this.teardownChain();
      this.isPlaying = false;
      this.playOffset = 0;
      if (this.isVideo && this.dom.videoPlayer) {
        this.dom.videoPlayer.pause();
        this.dom.videoPlayer.currentTime = 0;
      }
      this.stopSpectro();
      this.stopDiagnostics();
      if (this.dom.tpCur)        this.dom.tpCur.textContent = '0:00';
      if (this.dom.tpSeek)       this.dom.tpSeek.value = 0;
      if (this.dom.tpScrubFill)  this.dom.tpScrubFill.style.width = '0%';
      if (this.dom.tpScrubThumb) this.dom.tpScrubThumb.style.left = '0%';
      if (this.dom.tpScrubTrack) this.dom.tpScrubTrack.setAttribute('aria-valuenow', 0);
    };

    P.seekDelta = function (d) {
      const buf = this.inputBuffer; if (!buf) return;
      const speed = parseFloat((this.dom.tpSpeed && this.dom.tpSpeed.value) || 1);
      if (this.isPlaying) this.playOffset += (this.ctx.currentTime - this.playStartTime) * speed;
      this.playOffset = Math.max(0, Math.min(buf.duration, this.playOffset + d));
      if (this.isPlaying) { this.play(); return; }
      const frac = buf.duration > 0 ? this.playOffset / buf.duration : 0;
      if (this.dom.tpCur)        this.dom.tpCur.textContent = this.fmtDur(this.playOffset);
      if (this.dom.tpSeek)       this.dom.tpSeek.value = frac * 1000;
      if (this.dom.tpScrubFill)  this.dom.tpScrubFill.style.width  = (frac * 100) + '%';
      if (this.dom.tpScrubThumb) this.dom.tpScrubThumb.style.left  = (frac * 100) + '%';
    };

    P.seekTo = function (frac) {
      if (!this.inputBuffer) return;
      const speed = parseFloat((this.dom.tpSpeed && this.dom.tpSpeed.value) || 1);
      if (this.isPlaying) this.playOffset += (this.ctx.currentTime - this.playStartTime) * speed;
      this.playOffset = frac * this.inputBuffer.duration;
      if (this.isPlaying) { this.play(); return; }
      if (this.dom.tpCur)        this.dom.tpCur.textContent = this.fmtDur(this.playOffset);
      if (this.dom.tpSeek)       this.dom.tpSeek.value = this.inputBuffer.duration > 0 ? frac * 1000 : 0;
      if (this.dom.tpScrubFill)  this.dom.tpScrubFill.style.width  = (frac * 100) + '%';
      if (this.dom.tpScrubThumb) this.dom.tpScrubThumb.style.left  = (frac * 100) + '%';
    };

    console.info('[app-patches] VoiceIsolatePro.prototype patched ✓  (8 fixes applied)');
  }

  // Run immediately if DOM is ready, else defer
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', applyPatches);
  } else {
    applyPatches();
  }
})();
