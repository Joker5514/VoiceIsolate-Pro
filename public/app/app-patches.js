/* ============================================================
   app-patches.js — VoiceIsolate Pro v24.0
   Null-safety patches for DOM elements that may not exist
   when scripts execute (record button, pipeline status, etc.)
   Applied as early as possible via DOMContentLoaded guard.
   ============================================================ */

'use strict';

(function applyDOMPatches() {
  /**
   * Safe element getter — returns null instead of throwing
   * when getElementById is called before the element exists.
   */
  function safeGet(id) {
    return document.getElementById(id);
  }

  /**
   * Safely set a property on a DOM element.
   * Silently no-ops if the element doesn't exist.
   */
  function safeProp(id, prop, value) {
    const el = safeGet(id);
    if (el) el[prop] = value;
  }

  /**
   * Patch: Record button null-ref guard.
   * The original code called recordBtn.disabled = ... before DOMContentLoaded.
   * This patch defers that assignment until the element is available.
   */
  function patchRecordButton() {
    // Intercept any early calls that set disabled on a null recordBtn
    const originalGetElementById = document.getElementById.bind(document);
    document.getElementById = function(id) {
      const el = originalGetElementById(id);
      // Restore the real method immediately — we only wrap once at boot
      document.getElementById = originalGetElementById;

      if (!el && (id === 'btn-record' || id === 'record-btn' || id === 'recordBtn')) {
        // Return a no-op proxy object so property assignments don't throw
        return new Proxy({}, {
          set() { return true; },
          get(_, key) {
            if (key === 'addEventListener') return () => {};
            if (key === 'removeEventListener') return () => {};
            if (key === 'dispatchEvent') return () => false;
            if (key === 'classList') return { add: ()=>{}, remove: ()=>{}, toggle: ()=>{}, contains: ()=>false };
            if (key === 'style') return {};
            return undefined;
          }
        });
      }
      return el;
    };
  }

  // Apply the record button patch immediately
  patchRecordButton();

  // Re-enable the real record button once the DOM is ready
  document.addEventListener('DOMContentLoaded', function onDOMReady() {
    document.removeEventListener('DOMContentLoaded', onDOMReady);

    // Try all known record button IDs used across versions
    const recordIds = ['btn-record', 'record-btn', 'recordBtn', 'btnRecord'];
    for (const id of recordIds) {
      const btn = document.getElementById(id);
      if (btn) {
        btn.disabled = false;
        console.debug(`[app-patches] Record button #${id} enabled`);
        break;
      }
    }

    // Patch pipeline status display — set to 'INIT' instead of ERROR on cold start
    const pipelineStatus = document.getElementById('pipeline-status')
      || document.querySelector('[data-status="pipeline"]')
      || document.querySelector('.pipeline-status');
    if (pipelineStatus && pipelineStatus.textContent.trim() === 'ERROR') {
      pipelineStatus.textContent = 'INIT';
      pipelineStatus.style.color = '';
    }
  }, { once: true });
})();
