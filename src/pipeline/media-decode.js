'use strict';

import { SAMPLE_RATE } from '../core/audio-config.js';
import { inferMediaKind } from '../core/media-types.js';

const MEDIA_DECODE_TIMEOUT_MS = 60_000;
// ScriptProcessorNode block size — must be a power-of-two 256–16384.
const SPN_BLOCK_SIZE = 4096;

/**
 * Decode any supported blob to an AudioBuffer.
 *
 * Strategy:
 *  1. Fast path  — ctx.decodeAudioData()  (PCM/WAV/MP3/OGG/FLAC)
 *  2. Fallback   — live AudioContext + createMediaElementSource +
 *                  ScriptProcessorNode ring-buffer capture.
 *                  (M4A / AAC / MP4 / WebM containers the browser can
 *                  demux natively but decodeAudioData cannot handle.)
 *
 * ⚠️  OfflineAudioContext.createMediaElementSource() does NOT exist in
 *     any browser. The source MUST come from a live AudioContext.
 *
 * @param {Blob|File} blob
 * @returns {Promise<AudioBuffer>}
 */
export async function decodeBlobToAudioBuffer(blob) {
  let primaryErr = null;
  try {
    return await _decodeWithAudioData(blob);
  } catch (err) {
    primaryErr = err;
  }

  const kind = inferMediaKind(blob) || 'audio';
  try {
    return await _decodeViaMediaElement(blob, kind);
  } catch (fallbackErr) {
    throw new Error(
      `[VIP][FileIngestion] Could not decode '${blob.name || 'file'}'. ` +
      `(Web Audio: ${primaryErr?.message ?? primaryErr}; ` +
      `media fallback: ${fallbackErr?.message ?? fallbackErr})`
    );
  }
}

// ---------------------------------------------------------------------------
// Fast path — decodeAudioData
// ---------------------------------------------------------------------------
async function _decodeWithAudioData(blob) {
  const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!Ctx) throw new Error('Web Audio API is not available.');
  const arrayBuffer = await blob.arrayBuffer();
  const ctx = new Ctx();
  try {
    return await ctx.decodeAudioData(arrayBuffer.slice(0));
  } finally {
    try { await ctx.close(); } catch { /* already closed */ }
  }
}

// ---------------------------------------------------------------------------
// Fallback — live AudioContext + createMediaElementSource + ring-buffer
//
// OfflineAudioContext does NOT have createMediaElementSource() — it is a
// live-AudioContext-only API. We capture the output of the live graph with a
// ScriptProcessorNode and assemble PCM frames into an AudioBuffer ourselves.
// ---------------------------------------------------------------------------
async function _decodeViaMediaElement(blob, kind) {
  const doc = globalThis.document;
  if (!doc?.createElement || !doc.body) {
    throw new Error('Media element decode requires a browser document.');
  }
  const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!Ctx) throw new Error('Web Audio API is not available.');

  const url = URL.createObjectURL(blob);
  const tag = kind === 'video' ? 'video' : 'audio';
  const media = doc.createElement(tag);
  media.preload = 'auto';
  media.muted = false;
  media.setAttribute('playsinline', '');
  media.style.cssText = 'position:fixed;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none';
  doc.body.appendChild(media);
  media.src = url;

  let ctx = null;
  let timeoutHandle = null;
  try {
    // 1. Wait until metadata (duration / channels) is available.
    await _waitForMetadata(media);

    const duration = media.duration;
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error('Media has no decodable audio duration.');
    }

    // 2. Build the live audio graph.
    ctx = new Ctx({ sampleRate: SAMPLE_RATE });
    const source = ctx.createMediaElementSource(media); // ✅ valid on live ctx

    // 3. Ring-buffer via ScriptProcessorNode.
    //    SPN is deprecated but universally supported and gives us synchronous
    //    PCM access — the only option for a MediaElementSource on a live ctx.
    const numChannels = 2;
    const estimatedFrames = Math.ceil(duration * SAMPLE_RATE) + SPN_BLOCK_SIZE * 4;
    const chunks = [];            // Array<Array<Float32Array>>  [block][ch]
    let capturedFrames = 0;
    let resolveDone, rejectDone;
    const donePromise = new Promise((res, rej) => { resolveDone = res; rejectDone = rej; });

    const spn = ctx.createScriptProcessor(SPN_BLOCK_SIZE, numChannels, numChannels);
    const silentGain = ctx.createGain();
    silentGain.gain.setValueAtTime(0, ctx.currentTime);
    source.connect(spn);
    spn.connect(silentGain);
    silentGain.connect(ctx.destination); // must be connected to run

    spn.onaudioprocess = (e) => {
      const block = [];
      for (let ch = 0; ch < numChannels; ch++) {
        block.push(new Float32Array(e.inputBuffer.getChannelData(ch))); // copy!
      }
      chunks.push(block);
      capturedFrames += SPN_BLOCK_SIZE;
      if (capturedFrames >= estimatedFrames) {
        spn.onaudioprocess = null;
        resolveDone();
      }
    };

    // 4. Timeout guard (scaled to media duration + margin for real-time capture).
    const captureTimeoutMs = Math.max(
      MEDIA_DECODE_TIMEOUT_MS,
      Math.ceil(duration * 1000) + 10_000
    );
    timeoutHandle = setTimeout(() => {
      spn.onaudioprocess = null;
      rejectDone(new Error('Media element capture timed out after ' + (captureTimeoutMs / 1000) + 's'));
    }, captureTimeoutMs);

    // 5. Also resolve when the element fires 'ended' (handles short files
    //    that end before estimatedFrames is reached).
    const endedPromise = new Promise((res) => {
      media.addEventListener('ended', () => {
        // One extra SPN quantum to flush the tail.
        setTimeout(() => {
          spn.onaudioprocess = null;
          res();
        }, Math.ceil((SPN_BLOCK_SIZE / SAMPLE_RATE) * 1000) + 50);
      }, { once: true });
    });

    // 6. Start playback — required to drive the ScriptProcessorNode.
    await media.play();

    await Promise.race([donePromise, endedPromise]);
    clearTimeout(timeoutHandle);
    spn.onaudioprocess = null;

    // 7. Assemble captured chunks into a single AudioBuffer.
    const totalFrames = chunks.length * SPN_BLOCK_SIZE;
    const result = new AudioBuffer({
      numberOfChannels: numChannels,
      length: totalFrames,
      sampleRate: SAMPLE_RATE,
    });
    for (let ch = 0; ch < numChannels; ch++) {
      const dest = result.getChannelData(ch);
      let offset = 0;
      for (const block of chunks) {
        dest.set(block[ch], offset);
        offset += SPN_BLOCK_SIZE;
      }
    }

    if (!result.length) throw new Error('Media element produced an empty audio buffer.');
    return result;

  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    try { media.pause(); } catch { /* ignore */ }
    try { media.removeAttribute('src'); media.load(); media.remove(); } catch { /* ignore */ }
    URL.revokeObjectURL(url);
    if (ctx) try { await ctx.close(); } catch { /* already closed */ }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function _waitForMetadata(media) {
  return new Promise((resolve, reject) => {
    const HAVE_METADATA = globalThis.HTMLMediaElement?.HAVE_METADATA ?? 1;
    const timer = setTimeout(
      () => reject(new Error('Media metadata load timeout')),
      MEDIA_DECODE_TIMEOUT_MS
    );
    const done = () => { clearTimeout(timer); resolve(); };
    const fail = () => {
      clearTimeout(timer);
      const code = media.error?.code;
      const msg  = media.error?.message || 'Media element failed to load';
      reject(new Error(`${msg}${code ? ` (code ${code})` : ''}`));
    };
    if (media.readyState >= HAVE_METADATA) { done(); return; }
    media.addEventListener('loadedmetadata', done, { once: true });
    media.addEventListener('error',          fail, { once: true });
  });
}

export default decodeBlobToAudioBuffer;
