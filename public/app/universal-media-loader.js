/**
 * universal-media-loader.js
 * VoiceIsolate Pro — Universal Media Loader
 *
 * Supports: ANY audio or video format, ANY file size
 * Strategy:
 *   1. Magic-byte MIME sniffing (overrides unreliable browser MIME)
 *   2. < 200MB  → decodeAudioData directly
 *   3. 200MB+   → MediaSource streaming in 64MB chunks
 *   4. Video    → createMediaElementSource audio extraction
 *   5. Exotic   → WASM FFmpeg transcode → WAV → decodeAudioData
 *
 * No cloud calls. 100% local. Integrates with window.VIP global state.
 */

// ─────────────────────────────────────────────
// MIME REGISTRY
// ─────────────────────────────────────────────
const AUDIO_MIMES = new Set([
  'audio/mpeg','audio/mp3','audio/wav','audio/x-wav',
  'audio/flac','audio/x-flac','audio/ogg','audio/aiff',
  'audio/x-aiff','audio/mp4','audio/aac','audio/x-m4a',
  'audio/webm','audio/opus','audio/ac3','audio/eac3',
  'audio/x-caf','audio/amr','audio/3gpp','audio/x-ms-wma'
]);

const VIDEO_MIMES = new Set([
  'video/mp4','video/webm','video/ogg','video/quicktime',
  'video/x-msvideo','video/x-matroska','video/mpeg',
  'video/x-flv','video/3gpp','video/x-ms-wmv','video/hevc',
  'video/av1','video/h264','video/h265','video/mxf'
]);

// ─────────────────────────────────────────────
// MAGIC BYTE MIME SNIFFER
// Reads first 16 bytes — far more reliable than file.type
// ─────────────────────────────────────────────
async function sniffMimeType(file) {
  const buf = await file.slice(0, 16).arrayBuffer();
  const b   = new Uint8Array(buf);
  const hex = Array.from(b).map(x => x.toString(16).padStart(2,'0')).join('');

  // MP3 (ID3 tag or sync word)
  if (hex.startsWith('494433') || (b[0]===0xFF && (b[1]&0xE0)===0xE0)) return 'audio/mpeg';
  // WAV  RIFF....WAVE
  if (hex.startsWith('52494646') && hex.slice(16,24)==='57415645') return 'audio/wav';
  // FLAC fLaC
  if (hex.startsWith('664c6143')) return 'audio/flac';
  // OGG  OggS
  if (hex.startsWith('4f676753')) return 'audio/ogg';
  // MKV / WebM  EBML magic
  if (hex.startsWith('1a45dfa3')) return 'video/x-matroska';
  // MP4 / M4A  ftyp box (offset 4)
  if (b[4]===0x66&&b[5]===0x74&&b[6]===0x79&&b[7]===0x70) return 'video/mp4';
  // AVI  RIFF....AVI 
  if (hex.startsWith('52494646') && hex.slice(16,24)==='41564920') return 'video/x-msvideo';
  // AIFF FORM
  if (hex.startsWith('464f524d')) return 'audio/aiff';
  // AC3 sync
  if (b[0]===0x0B && b[1]===0x77) return 'audio/ac3';
  // Fallback to browser report
  return file.type || 'application/octet-stream';
}

const isVideo = mime => mime.startsWith('video/') || VIDEO_MIMES.has(mime);
const isAudio = mime => mime.startsWith('audio/') || AUDIO_MIMES.has(mime);

// ─────────────────────────────────────────────
// SIZE THRESHOLD — files above this stream via MediaSource
// ─────────────────────────────────────────────
const CHUNK_THRESHOLD = 200 * 1024 * 1024; // 200 MB
const STREAM_CHUNK    =  64 * 1024 * 1024; //  64 MB per pump

// ─────────────────────────────────────────────
// MASTER LOADER — routes to correct strategy
// ─────────────────────────────────────────────
async function loadAudioFromFile(file) {
  const mime = await sniffMimeType(file);
  _vipStatus(`Detected: ${mime} | ${(file.size/1e6).toFixed(1)} MB`);

  if (isVideo(mime))                  return extractAudioFromVideo(file, mime);
  if (file.size < CHUNK_THRESHOLD)    return decodeDirectly(file);
  return decodeStreaming(file, mime);
}

// ─────────────────────────────────────────────
// STRATEGY 1 — Direct decode (< 200 MB audio)
// ─────────────────────────────────────────────
async function decodeDirectly(file) {
  const ab = await file.arrayBuffer();
  try {
    return await _audioCtx().decodeAudioData(ab);
  } catch (err) {
    console.warn('[VIP] Native decode failed, falling back to WASM FFmpeg:', err);
    return decodeWithFFmpegWASM(file);
  }
}

// ─────────────────────────────────────────────
// STRATEGY 2 — MediaSource streaming (200 MB+ audio)
// Pumps 64 MB chunks into a SourceBuffer, then
// captures via OfflineAudioContext for pipeline use.
// ─────────────────────────────────────────────
async function decodeStreaming(file, mime) {
  return new Promise((resolve, reject) => {
    const ctx        = _audioCtx();
    const offlineCtx = new OfflineAudioContext(2, ctx.sampleRate * 7200, ctx.sampleRate);
    const ms         = new MediaSource();
    const audio      = new Audio();
    audio.src        = URL.createObjectURL(ms);

    ms.addEventListener('sourceopen', async () => {
      // Prefer audio/mpeg as the SourceBuffer codec for broadest compat
      const sbMime = MediaSource.isTypeSupported(mime) ? mime : 'audio/mpeg';
      const sb     = ms.addSourceBuffer(sbMime);
      sb.mode      = 'sequence';
      let offset   = 0;

      const pump = async () => {
        if (sb.updating) return; // wait for updateend
        if (offset >= file.size) { ms.endOfStream(); return; }
        const chunk = await file.slice(offset, offset + STREAM_CHUNK).arrayBuffer();
        sb.appendBuffer(chunk);
        offset += STREAM_CHUNK;
        _vipProgress(Math.round((offset / file.size) * 50));
      };

      sb.addEventListener('updateend', pump);
      await pump();

      audio.addEventListener('canplaythrough', async () => {
        const src = offlineCtx.createMediaElementSource(audio);
        src.connect(offlineCtx.destination);
        audio.play();
        const rendered = await offlineCtx.startRendering();
        URL.revokeObjectURL(audio.src);
        resolve(rendered);
      }, { once: true });

      audio.addEventListener('error', reject, { once: true });
    });
  });
}

// ─────────────────────────────────────────────
// STRATEGY 3 — Video audio extraction
// Uses createMediaElementSource for zero-copy audio pull
// Works for MP4, MKV, WebM, MOV, AVI, etc.
// ─────────────────────────────────────────────
async function extractAudioFromVideo(file, mime) {
  const url    = URL.createObjectURL(file);
  const videoEl = document.createElement('video');
  videoEl.src  = url;
  videoEl.preload = 'metadata';
  document.body.appendChild(videoEl); // must be in DOM for some browsers

  await new Promise((res, rej) => {
    videoEl.onloadedmetadata = res;
    videoEl.onerror          = () => rej(new Error(`Video load failed: ${mime}`));
    setTimeout(() => rej(new Error('Video metadata timeout')), 20000);
  });

  const sr         = _audioCtx().sampleRate;
  const offlineCtx = new OfflineAudioContext(2, Math.ceil(videoEl.duration * sr), sr);
  const src        = offlineCtx.createMediaElementSource(videoEl);
  src.connect(offlineCtx.destination);
  videoEl.muted = true;
  videoEl.play();

  const rendered = await offlineCtx.startRendering();
  URL.revokeObjectURL(url);
  videoEl.remove();
  return rendered;
}

// ─────────────────────────────────────────────
// STRATEGY 4 — WASM FFmpeg fallback
// Handles: AC3, DTS, AIFF, AMR, WMA, exotic containers
// Requires /public/wasm/ffmpeg.js + ffmpeg-core.js/.wasm hosted locally
// ─────────────────────────────────────────────
let _ffmpegInstance = null;

async function _getFFmpeg() {
  if (_ffmpegInstance) return _ffmpegInstance;
  if (!window.FFmpegWASM) throw new Error('FFmpeg WASM not loaded. Add /wasm/ffmpeg.js to index.html');
  const { FFmpeg } = window.FFmpegWASM;
  _ffmpegInstance  = new FFmpeg();
  _ffmpegInstance.on('log', ({ message }) => console.debug('[FFmpeg]', message));
  _ffmpegInstance.on('progress', ({ progress }) => _vipProgress(Math.round(progress * 100)));
  await _ffmpegInstance.load({
    coreURL: '/wasm/ffmpeg-core.js',
    wasmURL: '/wasm/ffmpeg-core.wasm',
  });
  return _ffmpegInstance;
}

async function decodeWithFFmpegWASM(file) {
  const ff      = await _getFFmpeg();
  const ext     = file.name.split('.').pop().toLowerCase() || 'bin';
  const inName  = `input.${ext}`;
  const outName = 'output.wav';

  _vipStatus('Transcoding with WASM FFmpeg...');
  await ff.writeFile(inName, new Uint8Array(await file.arrayBuffer()));
  await ff.exec([
    '-i', inName,
    '-ac', '2',
    '-ar', String(_audioCtx().sampleRate),
    '-sample_fmt', 's16',
    outName
  ]);

  const data = await ff.readFile(outName);
  await ff.deleteFile(inName);
  await ff.deleteFile(outName);
  return _audioCtx().decodeAudioData(data.buffer.slice(0));
}

// ─────────────────────────────────────────────
// DROP ZONE + FILE INPUT WIRING
// Call initUniversalMediaLoader() once on DOMContentLoaded
// ─────────────────────────────────────────────
function initUniversalMediaLoader() {
  const dropZone  = document.getElementById('drop-zone');
  const fileInput = document.getElementById('file-input');

  if (!dropZone || !fileInput) {
    console.error('[VIP] drop-zone or file-input element not found in DOM');
    return;
  }

  // Remove any restrictive accept/size attributes
  fileInput.removeAttribute('accept');
  fileInput.setAttribute('accept', 'audio/*,video/*,*/*');

  fileInput.addEventListener('change', async e => {
    const file = e.target.files[0];
    if (file) await handleMediaFile(file);
    e.target.value = ''; // reset so same file can be re-loaded
  });

  dropZone.addEventListener('dragover',  e => { e.preventDefault(); dropZone.classList.add('drag-active'); });
  dropZone.addEventListener('dragleave', ()  => dropZone.classList.remove('drag-active'));
  dropZone.addEventListener('dragend',   ()  => dropZone.classList.remove('drag-active'));

  dropZone.addEventListener('drop', async e => {
    e.preventDefault();
    dropZone.classList.remove('drag-active');
    const file = e.dataTransfer.files[0];
    if (file) await handleMediaFile(file);
  });

  // Click on drop zone opens file picker
  dropZone.addEventListener('click', () => fileInput.click());
}

// ─────────────────────────────────────────────
// MASTER HANDLER
// ─────────────────────────────────────────────
async function handleMediaFile(file) {
  try {
    _vipSpinner(true);
    _vipStatus(`Loading: ${file.name} (${(file.size/1e6).toFixed(1)} MB)`);
    _vipProgress(0);

    const audioBuffer = await loadAudioFromFile(file);

    // Store on global VIP state for DSP pipeline access
    window.VIP            = window.VIP || {};
    window.VIP.sourceBuffer = audioBuffer;
    window.VIP.fileName   = file.name;
    window.VIP.fileMime   = await sniffMimeType(file);
    window.VIP.fileSize   = file.size;

    const ch  = audioBuffer.numberOfChannels;
    const sr  = (audioBuffer.sampleRate / 1000).toFixed(1);
    const dur = audioBuffer.duration.toFixed(2);
    _vipStatus(`✓ Loaded — ${ch}ch / ${sr}kHz / ${dur}s`);
    _vipProgress(100);

    // Notify other modules
    document.dispatchEvent(new CustomEvent('vip:mediaLoaded', { detail: { audioBuffer, file } }));

  } catch (err) {
    console.error('[VIP] Media load failed:', err);
    _vipStatus(`✗ Failed: ${err.message}`);
  } finally {
    _vipSpinner(false);
  }
}

// ─────────────────────────────────────────────
// INTERNAL HELPERS — safe getters / UI shims
// ─────────────────────────────────────────────
function _audioCtx() {
  // Reuse existing context from app.js if available
  if (window.VIP?.audioContext) return window.VIP.audioContext;
  if (!window._vipFallbackCtx)  window._vipFallbackCtx = new AudioContext();
  return window._vipFallbackCtx;
}

function _vipStatus(msg) {
  console.info('[VIP]', msg);
  const el = document.getElementById('status-text') ||
             document.getElementById('processing-status') ||
             document.querySelector('.status-display');
  if (el) el.textContent = msg;
}

function _vipProgress(pct) {
  const el = document.getElementById('progress-bar') ||
             document.getElementById('loading-progress') ||
             document.querySelector('.progress-fill');
  if (el) el.style.width = `${pct}%`;
}

function _vipSpinner(show) {
  const el = document.getElementById('loading-spinner') ||
             document.querySelector('.spinner');
  if (el) el.style.display = show ? 'block' : 'none';
}

// Auto-init when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initUniversalMediaLoader);
} else {
  initUniversalMediaLoader();
}

// Export for ES module usage if needed
if (typeof module !== 'undefined') {
  module.exports = { loadAudioFromFile, handleMediaFile, sniffMimeType, initUniversalMediaLoader };
}
