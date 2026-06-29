// ============================================================
// VoiceIsolate Pro — Audio File Handoff Bridge
// public/app/handoff-bridge.js
//
// Handles 3-layer file transfer from landing page → /app
// Priority: Layer 2 (blob URL) → Layer 1 (opener File) → Layer 3 (sessionStorage)
//
// Constraints:
//   - 100% local: fetch() targets only local blob: URLs, never external servers
//   - Single AudioContext at 48kHz (Demucs v4.1 / BSRNN compatibility)
//   - Gracefully degrades to drop zone on all failure paths
// ============================================================

document.addEventListener('DOMContentLoaded', async () => {

  // ── LAYER RESOLUTION ──────────────────────────────────────────────────────
  const params   = new URLSearchParams(location.search);
  const blobUrl  = params.get('blob');          // Layer 2 — most reliable post-navigation
  const fileName = params.get('file') || 'audio-input';

  // Layer 1 — direct File object injected by landing page via window.opener
  const file = window.opener?.VIP_PENDING_FILE
             || window.VIP_PENDING_FILE;

  try {
    if (blobUrl) {
      // ── LAYER 2: Blob URL ──────────────────────────────────────────────────
      // fetch() here targets a local blob: URL — never an external server.
      // Revoke immediately after reading to free memory.
      try {
        const response = await fetch(blobUrl);
        if (!response.ok) throw new Error('Blob fetch failed: ' + response.status);
        const arrayBuffer = await response.arrayBuffer();
        await decodeAndLoadAudio(arrayBuffer, fileName);
      } finally {
        globalThis.URL?.revokeObjectURL?.(blobUrl); // Free memory — blob no longer needed
      }

    } else if (file instanceof File) {
      // ── LAYER 1: File Object via window.opener ─────────────────────────────
      const arrayBuffer = await file.arrayBuffer();
      // Null out reference — don't hold the File in opener memory
      if (window.opener) window.opener.VIP_PENDING_FILE = null;
      window.VIP_PENDING_FILE = null;
      await decodeAndLoadAudio(arrayBuffer, file.name);

    } else {
      // ── LAYER 3: sessionStorage Base64 DataURL fallback ───────────────────
      const dataUrl = sessionStorage.getItem('vip_pending_data');
      if (dataUrl) {
        sessionStorage.removeItem('vip_pending_data'); // Consume-once semantics
        await loadFromDataUrl(dataUrl);
      } else {
        // No file passed via any channel — show the empty drop zone UI
        showDropZone();
      }
    }
  } catch (err) {
    console.error('[VIP] Handoff bridge error:', err);
    showHandoffError(err.message);
    showDropZone(); // Graceful degradation: let user re-upload manually
  }

});

// ============================================================
// decodeAndLoadAudio
// Single entry point for all ArrayBuffer paths.
// Initializes AudioContext at 48kHz, runs decodeAudioData,
// then hands off the AudioBuffer to the 32-stage DSP pipeline.
// ============================================================
export async function decodeAndLoadAudio(arrayBuffer, name = 'audio') {
  updateStatus(`Decoding "${name}"\u2026`, 'loading');

  try {
    // Initialize shared AudioContext (48kHz matches Demucs v4.1 / BSRNN input)
    if (!window.vipAudioContext) {
      window.vipAudioContext = new (window.AudioContext || window.webkitAudioContext)({
        sampleRate: 48000,
        latencyHint: 'playback'   // Creator/Forensic default; switch to 'interactive' for Live mode
      });
    }

    const ctx = window.vipAudioContext;
    if (ctx.state === 'suspended') await ctx.resume();

    // decodeAudioData handles MP3, WAV, FLAC, OGG, M4A natively.
    // Pass arrayBuffer directly since we do not need to preserve the original buffer in this handoff flow.
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer);

    updateStatus(
      `Loaded: ${name} (${audioBuffer.duration.toFixed(2)}s \u2022 ${audioBuffer.sampleRate}Hz \u2022 ${audioBuffer.numberOfChannels}ch)`,
      'ready'
    );
    updateFileLabel(name);

    // ── Hand off to the 32-stage DSP pipeline ─────────────────────────────
    // initDSPPipeline is defined in app.js and wires the AudioBuffer into
    // the AudioWorklet + ML inference chain.
    if (typeof initDSPPipeline === 'function') {
      await initDSPPipeline(audioBuffer);
    } else {
      console.warn('[VIP] initDSPPipeline not found — DSP pipeline not wired.');
    }

  } catch (err) {
    if (err.name === 'EncodingError' || err.message?.includes('decode')) {
      showHandoffError(`Could not decode "${name}". Supported formats: WAV, MP3, FLAC, OGG, M4A.`);
    } else {
      throw err; // Re-throw non-decode errors to outer handler
    }
  }
}

// ============================================================
// loadFromDataUrl
// Layer 3 fallback: converts base64 DataURL → ArrayBuffer.
// Called when sessionStorage holds a vip_pending_data entry.
// ============================================================
export async function loadFromDataUrl(dataUrl) {
  updateStatus('Restoring from session\u2026', 'loading');

  // Extract MIME type to derive a filename with the correct extension
  const [header, base64] = dataUrl.split(',');
  const mimeMatch = header.match(/data:([^;]+)/);
  const mime = mimeMatch ? mimeMatch[1] : 'audio/wav';
  const ext  = mime.split('/')[1] || 'wav';
  const name = `session-audio.${ext}`;

  // Decode base64 string → Uint8Array → ArrayBuffer
  const binaryStr = atob(base64);
  const bytes     = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }

  await decodeAndLoadAudio(bytes.buffer, name);
}

// ============================================================
// Landing Page Sender (reference implementation)
// Place this in your landing page JS, not in the app.
//
// Usage: call sendFileToApp(file) from your drop/pick handler.
// ============================================================
export async function sendFileToApp(file, appUrl = '/app/index.html') {
  // Layer 2: Blob URL survives cross-page navigation (same origin)
  const blobUrl  = URL.createObjectURL(file);
  const target   = `${appUrl}?blob=${encodeURIComponent(blobUrl)}&file=${encodeURIComponent(file.name)}`;

  // Layer 1: Attach to window so app can read via window.opener
  window.VIP_PENDING_FILE = file;

  // Layer 3: Encode to sessionStorage for same-tab soft navigations
  // Guard: only encode files under 4MB to avoid QuotaExceededError
  // (base64 encoding inflates size ~33%, so 4MB → ~5.3MB — near the 5MB quota)
  if (file.size < 4 * 1024 * 1024) {
    try {
      await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload  = () => {
          try {
            sessionStorage.setItem('vip_pending_data', reader.result);
            resolve();
          } catch (err) {
            reject(err);
          }
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
    } catch (err) {
      console.warn('[VIP] Failed to write to sessionStorage (Layer 3 fallback):', err);
    }
  }

  // Open the app in a new tab (enables window.opener access for Layer 1)
  window.open(target, '_blank');
  // Note: blob URL is revoked by the app after consumption (Layer 2)
}

// ============================================================
// UI Helpers — wire to actual DOM element IDs in index.html
// ============================================================
function updateStatus(message, state = 'idle') {
  const el = document.getElementById('status-text');
  if (!el) return;
  el.textContent    = message;
  el.dataset.state  = state;  // CSS can target [data-state="loading"], [data-state="ready"]
}

function updateFileLabel(name) {
  const el = document.getElementById('file-name-label');
  if (el) el.textContent = name;
}

function showDropZone() {
  const dz = document.getElementById('drop-zone');
  if (dz) dz.classList.remove('hidden');
}

function showHandoffError(msg) {
  const el = document.getElementById('handoff-error');
  if (!el) { console.error('[VIP Handoff Error]', msg); return; }
  el.textContent = `\u26A0 ${msg}`;
  el.classList.remove('hidden');
}
