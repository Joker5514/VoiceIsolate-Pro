/**
 * VoiceIsolate-Pro — Android Platform Adapter
 * Touch-native presentation, same workflow semantics as browser/desktop
 * - tap/drag selection
 * - pinch zoom
 * - horizontal timeline pan
 * - large draggable selection handles (44-48dp)
 * - bottom sheet instead of floating menus
 * - compact bottom navigation
 * - haptic confirmation
 */

export class AndroidAdapter {
  constructor(sessionStore, uiStore) {
    this.sessionStore = sessionStore;
    this.uiStore = uiStore;
    this.platform = 'android';
  }

  async detectCapabilities() {
    const caps = {
      platform: 'android',
      webgpu: false,
      wasm: true,
      threads: false,
      sampleRate: 48000,
      touch: true,
      haptic: false,
    };
    try {
      caps.haptic = 'vibrate' in navigator;
    } catch {}
    // Android WebView often doesn't support WebGPU yet
    try {
      if (navigator.gpu) {
        const adapter = await navigator.gpu.requestAdapter();
        caps.webgpu = Boolean(adapter);
      }
    } catch {}
    return caps;
  }

  setupDragDrop() {
    // No drag/drop on Android — use file picker
    return () => {};
  }

  setupFilePicker(input, onFile) {
    if (!input) return () => {};
    const onChange = () => {
      const file = input.files?.[0];
      if (file) {
        try { if (navigator.vibrate) navigator.vibrate(20); } catch {}
        onFile(file);
      }
      input.value = '';
    };
    input.addEventListener('change', onChange);
    return () => input.removeEventListener('change', onChange);
  }

  setupKeyboardShortcuts() {
    // Minimal keyboard on Android
    return () => {};
  }

  hapticConfirm(type = 'light') {
    try {
      if (!navigator.vibrate) return;
      const patterns = {
        light: 10,
        medium: 20,
        heavy: 30,
        selection: [10, 30, 10],
        success: [10, 50, 20],
      };
      navigator.vibrate(patterns[type] || 10);
    } catch {}
  }

  getTouchTargetSize() { return 48; } // 48dp minimum

  setupBottomSheet(sheetEl) {
    if (!sheetEl) return () => {};
    // Swipe to dismiss
    let startY = 0;
    let currentY = 0;
    let isDragging = false;

    const onTouchStart = (e) => {
      startY = e.touches[0].clientY;
      isDragging = true;
      sheetEl.style.transition = 'none';
    };
    const onTouchMove = (e) => {
      if (!isDragging) return;
      currentY = e.touches[0].clientY;
      const delta = Math.max(0, currentY - startY);
      sheetEl.style.transform = `translateY(${delta}px)`;
    };
    const onTouchEnd = () => {
      isDragging = false;
      sheetEl.style.transition = 'transform 0.32s cubic-bezier(0.22, 0.7, 0.2, 1)';
      const delta = currentY - startY;
      if (delta > 100) {
        sheetEl.style.transform = 'translateY(100%)';
        setTimeout(() => { sheetEl.style.display = 'none'; }, 320);
      } else {
        sheetEl.style.transform = 'translateY(0)';
      }
    };

    sheetEl.addEventListener('touchstart', onTouchStart, { passive: true });
    sheetEl.addEventListener('touchmove', onTouchMove, { passive: false });
    sheetEl.addEventListener('touchend', onTouchEnd);

    return () => {
      sheetEl.removeEventListener('touchstart', onTouchStart);
      sheetEl.removeEventListener('touchmove', onTouchMove);
      sheetEl.removeEventListener('touchend', onTouchEnd);
    };
  }
}

export default AndroidAdapter;
