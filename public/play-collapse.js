/**
 * Collapsible cyan play button.
 * Persists in localStorage. Does not start, stop, or reroute playback.
 */
(function (root, factory) {
  const api = factory();
  root.VIPPlayCollapse = api;
  if (typeof document !== 'undefined') {
    const start = function () { api.mount(document); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const KEY = 'vip-play-collapsed';

  function readCollapsed(storage) {
    try {
      return !!(storage && storage.getItem(KEY) === '1');
    } catch (_) {
      return false;
    }
  }

  function writeCollapsed(storage, collapsed) {
    try {
      if (!storage) return false;
      storage.setItem(KEY, collapsed ? '1' : '0');
      return true;
    } catch (_) {
      return false;
    }
  }

  function nextState(collapsed) {
    const hidden = !!collapsed;
    return {
      collapsed: hidden,
      expanded: !hidden,
      toggleLabel: hidden ? 'Expand play button' : 'Collapse play button',
      playHidden: hidden,
    };
  }

  function applyTo(slot, toggle, play, collapsed) {
    const state = nextState(collapsed);
    if (slot) slot.classList.toggle('is-collapsed', state.collapsed);
    if (toggle) {
      toggle.setAttribute('aria-expanded', state.expanded ? 'true' : 'false');
      toggle.setAttribute('aria-label', state.toggleLabel);
    }
    if (play) {
      play.setAttribute('aria-disabled', play.disabled ? 'true' : 'false');
      if (state.playHidden) {
        play.setAttribute('aria-hidden', 'true');
        play.setAttribute('tabindex', '-1');
      } else {
        play.removeAttribute('aria-hidden');
        if (play.getAttribute('tabindex') === '-1') play.removeAttribute('tabindex');
      }
    }
    return state;
  }

  function mount(doc, storage) {
    if (!doc || typeof doc.querySelectorAll !== 'function') return;
    const store = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    const toggles = doc.querySelectorAll('[data-vip-play-toggle]');
    toggles.forEach(function (toggle) {
      const playId = toggle.getAttribute('aria-controls');
      const slot = toggle.closest ? toggle.closest('.vip-play-slot') : null;
      if (!playId || !slot) return;
      let collapsed = readCollapsed(store);
      const livePlay = function () { return doc.getElementById(playId); };
      const paint = function () { applyTo(slot, toggle, livePlay(), collapsed); };
      paint();
      toggle.addEventListener('click', function (event) {
        event.preventDefault();
        event.stopPropagation();
        const play = livePlay();
        collapsed = toggle.getAttribute('aria-expanded') === 'true';
        paint();
        writeCollapsed(store, collapsed);
        if (collapsed && play && doc.activeElement === play) toggle.focus();
      });
      // Engineer transport clones #tpPlay after boot. The slot stays; retarget the new button.
      if (typeof MutationObserver === 'function') {
        const observer = new MutationObserver(function () { paint(); });
        observer.observe(slot, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['disabled'],
        });
      }
    });
  }

  return {
    KEY: KEY,
    readCollapsed: readCollapsed,
    writeCollapsed: writeCollapsed,
    nextState: nextState,
    applyTo: applyTo,
    mount: mount,
  };
});
