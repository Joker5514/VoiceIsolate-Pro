'use strict';

(function () {
  function runControlsDiagnostic() {
    var results = [];
    var passed = 0;
    var failed = 0;

    function check(label, condition) {
      var ok = Boolean(condition);
      results.push({ label: label, ok: ok });
      if (ok) { passed++; } else { failed++; }
    }

    // Play / transport controls
    check('processBtn exists', document.getElementById('processBtn'));
    check('tpPlay exists', document.getElementById('tpPlay'));
    check('clearFile exists', document.getElementById('clearFile'));
    check('fileInput exists', document.getElementById('fileInput'));

    // Slider tabs
    var tabs = ['gate', 'nr', 'eq', 'dyn', 'spec', 'adv', 'sep', 'out'];
    tabs.forEach(function (t) {
      check('tab-' + t + ' exists', document.getElementById('tab-' + t));
    });

    // VIP app instance
    check('window._vipApp initialised', window._vipApp);
    check('togglePlayback is a function', window._vipApp && typeof window._vipApp.togglePlayback === 'function');
    check('applyPreset is a function', window._vipApp && typeof window._vipApp.applyPreset === 'function');

    var summary = {
      passed: passed,
      failed: failed,
      total: results.length,
      results: results,
      ok: failed === 0,
    };

    window.__vipControlsDiagnosticResult = summary;
    return summary;
  }

  window.runControlsDiagnostic = runControlsDiagnostic;
})();
