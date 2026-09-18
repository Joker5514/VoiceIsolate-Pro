/**
 * VoiceIsolate-Pro — Desktop Platform Adapter
 * Same workstation architecture as Browser where practical
 * - Native file/open/save integration
 * - file drag/drop
 * - keyboard shortcuts
 * - larger split-pane inspector
 * - native device integration through platform adapter
 */

export class DesktopAdapter {
  constructor(sessionStore, uiStore) {
    this.sessionStore = sessionStore;
    this.uiStore = uiStore;
    this.platform = 'desktop';
    this._isElectron = false;
    try {
      this._isElectron = typeof window !== 'undefined' && (window.__VIP_DESKTOP__ || navigator.userAgent.includes('Electron'));
    } catch {}
  }

  async detectCapabilities() {
    const caps = {
      platform: 'desktop',
      webgpu: false,
      wasm: true,
      threads: true,
      sampleRate: 48000,
      electron: this._isElectron,
      fileSystem: this._isElectron,
    };
    try {
      if (navigator.gpu) {
        const adapter = await navigator.gpu.requestAdapter();
        caps.webgpu = Boolean(adapter);
      }
    } catch {}
    try {
      caps.threads = typeof SharedArrayBuffer !== 'undefined';
    } catch {}
    return caps;
  }

  async openFileNative() {
    // Try Electron IPC first
    try {
      if (window.vipDesktop?.openFile) {
        const result = await window.vipDesktop.openFile();
        if (result && !result.canceled && result.buffer) {
          const blob = new Blob([result.buffer]);
          const file = new File([blob], result.filePath?.split('/').pop() || 'imported', { type: blob.type || 'audio/wav' });
          file.__nativePath = result.filePath;
          return file;
        }
      }
    } catch (e) {
      console.warn('[DesktopAdapter] native open failed', e);
    }
    return null;
  }

  async saveFileNative(blob, defaultName) {
    try {
      if (window.vipDesktop?.saveFile) {
        const buffer = await blob.arrayBuffer();
        const result = await window.vipDesktop.saveFile({ buffer, defaultName });
        return result;
      }
    } catch (e) {
      console.warn('[DesktopAdapter] native save failed', e);
    }
    // Fallback to browser download
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = defaultName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return { canceled: false, filePath: defaultName };
  }

  setupDragDrop(dropZone, onFile) {
    if (!dropZone) return () => {};
    const onDragOver = (e) => {
      e.preventDefault();
      dropZone.classList.add('drag-over');
    };
    const onDragLeave = (e) => {
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
      if (e.target.matches('input, textarea, select')) return;
      if (e.code === 'Space') {
        e.preventDefault();
        handlers.playPause?.();
      } else if (e.key.toLowerCase() === 'x') {
        handlers.abToggle?.();
      } else if (e.key === 'Escape') {
        handlers.clearSelection?.();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        handlers.openFile?.();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        handlers.export?.();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'e') {
        e.preventDefault();
        handlers.enhance?.();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }

  getTouchTargetSize() { return 32; }
}

export default DesktopAdapter;
