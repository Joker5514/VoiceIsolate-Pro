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
        const stageName = (typeof STAGES !== 'undefined' && STAGES[i]) ? STAGES[i] : ('Stage ' + (i + 1));
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

    if (typeof structuredLog === 'function') {
      structuredLog('info', 'Processing overlay patch applied');
    }
  }

  patchWhenReady();
}());
