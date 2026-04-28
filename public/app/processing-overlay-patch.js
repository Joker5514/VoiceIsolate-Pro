/* ============================================================
   VoiceIsolate Pro — app.js overlay integration patch
   Monkey-patches VoiceIsolatePro prototype to wire VIPOverlay
   into runPipeline() and pip().

   Load AFTER app.js:
     <script src="/app/app.js"></script>
     <script src="/app/processing-overlay.js"></script>
     <script src="/app/processing-overlay-patch.js"></script>
   ============================================================ */

(function () {
  'use strict';

  // Wait until the app class is instantiated on window.vip
  function patchWhenReady (attempts) {
    attempts = attempts || 0;
    const vip = window.vip || window._vipApp;
    if (!vip || typeof vip.runPipeline !== 'function') {
      if (attempts < 80) setTimeout(() => patchWhenReady(attempts + 1), 100);
      return;
    }
    applyPatches(vip);
  }

  function applyPatches (vip) {
    // Idempotency guard — prevents double-wrapping on hot-reload or duplicate script load
    if (vip._overlayPatched) return;
    vip._overlayPatched = true;

    // ── showProcessingOverlay ──────────────────────────────────
    vip.showProcessingOverlay = function (stageName, pct) {
      if (window.VIPOverlay) window.VIPOverlay.show(stageName, pct);
    };

    // ── hideProcessingOverlay ──────────────────────────────────
    vip.hideProcessingOverlay = function () {
      if (window.VIPOverlay) window.VIPOverlay.hide();
    };

    // ── updateProcessingOverlay ───────────────────────────────
    vip.updateProcessingOverlay = function (stageName, pct, stageIndex) {
      if (window.VIPOverlay) window.VIPOverlay.update(stageName, pct, stageIndex);
    };

    // ── Patch pip() to call updateProcessingOverlay ───────────
    const origPip = vip.pip ? vip.pip.bind(vip) : null;
    if (origPip) {
      vip.pip = async function (i, t) {
        const pct = Math.round((i + 1) / t * 100);
        // STAGES lives in app.js closure scope, not as a global. Read it via the app instance.
        const stages = window._vipApp && window._vipApp.STAGES;
        const stageName = (stages && stages[i]) ? stages[i] : ('Stage ' + (i + 1));
        this.updateProcessingOverlay(stageName, pct, i);
        return origPip(i, t);
      };
    }

    // ── Patch runPipeline() to show/hide overlay ──────────────
    const origRun = vip.runPipeline.bind(vip);
    vip.runPipeline = async function () {
      this.showProcessingOverlay('Preparing pipeline…', 0);
      try {
        return await origRun();
      } finally {
        this.hideProcessingOverlay();
      }
    };

    console.info('[VIPOverlay] Overlay patch applied.');
  }

  patchWhenReady();
}());
