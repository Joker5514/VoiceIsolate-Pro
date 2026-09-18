/**
 * VoiceIsolate-Pro — Browser Platform Adapter
 * Implements platform-specific UI differences for browser
 * - Mouse/trackpad signal selection
 * - Drag/drop import
 * - File picker
 * - Wheel/pinch-compatible zoom
 * - Keyboard shortcuts
 * - WebGPU acceleration where available
 * - WASM fallback path
 * - Responsive inspector/drawers
 */

export class BrowserAdapter {
  constructor(sessionStore, uiStore) {
    this.sessionStore = sessionStore;
    this.uiStore = uiStore;
    this.platform = 'browser';
  }

  async detectCapabilities() {
    const caps = {
      platform: 'browser',
      webgpu: false,
      wasm: true,
      threads: false,
      sampleRate: 48000,
    };
    try {
      if (typeof navigator !== 'undefined' && navigator.gpu) {
        try {
          const adapter = await navigator.gpu.requestAdapter();
          caps.webgpu = Boolean(adapter);
        } catch {}
      }
    } catch {}
    try {
      caps.threads = typeof SharedArrayBuffer !== 'undefined' && typeof crossOriginIsolated !== 'undefined' ? crossOriginIsolated : false;
    } catch {}
    return caps;
  }

  setupDragDrop(dropZone, onFile) {
    if (!dropZone) return () => {};
    const onDragOver = (e) => {
      e.preventDefault();
      dropZone.classList.add('drag-over');
    };
    const onDragLeave = (e) => {
      // Only leave if not entering child
      if (!dropZone.contains(e.relatedTarget)) dropZone.classList.remove('drag-over');
    };
    const onDrop = (e) => {
      e.preventDefault();
      dropZone.classList.remove('drag-over');
      const file = e.dataTransfer?.files?.[0];
      if (file) onFile(file);
    };
    dropZone.addEventListener('dragover', onDragOver);
    dropZone.addEventListener('dragleave', onDragLeave);
    dropZone.addEventListener('drop', onDrop);
    return () => {
      dropZone.removeEventListener('dragover', onDragOver);
      dropZone.removeEventListener('dragleave', onDragLeave);
      dropZone.removeEventListener('drop', onDrop);
    };
  }

  setupFilePicker(input, onFile) {
    if (!input) return () => {};
    const onChange = () => {
      const file = input.files?.[0];
      if (file) onFile(file);
      input.value = '';
    };
    input.addEventListener('change', onChange);
    return () => input.removeEventListener('change', onChange);
  }

  setupKeyboardShortcuts(handlers = {}) {
    const onKey = (e) => {
      // Don't interfere when typing
      if (e.target.matches('input, textarea, select')) return;
      if (e.code === 'Space') {
        e.preventDefault();
        handlers.playPause?.();
      } else if (e.key.toLowerCase() === 'x') {
        handlers.abToggle?.();
      } else if (e.key === 'Escape') {
        handlers.clearSelection?.();
      } else if (e.key.toLowerCase() === 'l') {
        handlers.toggleLoop?.();
      } else if (e.key === '[') {
        handlers.cropIn?.();
      } else if (e.key === ']') {
        handlers.cropOut?.();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }

  getTouchTargetSize() { return 32; } // browser can be smaller
}

export default BrowserAdapter;
