'use strict';

/** Common audio container extensions browsers can demux via decodeAudioData or media element. */
// Note: `.webm` is intentionally NOT listed here — it is ambiguous (audio or video).
// Use `inferMediaKind()` / `isVideoSource()` which prefer MIME for ambiguous containers.
export const AUDIO_EXTENSIONS = /\.(wav|wave|mp3|m4a|aac|ogg|oga|opus|flac|weba|wma|aiff?|caf|mka|m4b|m4r|amr|3ga|ape|wv|tta|ac3|eac3|dts)$/i;

/** Common video container extensions (audio track extracted via decode or media element). */
export const VIDEO_EXTENSIONS = /\.(mp4|m4v|mov|mkv|avi|ogv|3gp|3g2|wmv|mpeg|mpg|webm|ts|m2ts|mts|flv|f4v|asf|divx)$/i;

/** Containers that may be audio-only or video depending on tracks / MIME. */
export const AMBIGUOUS_MEDIA_EXTENSIONS = /\.(webm)$/i;

/** MIDI is never supported by the Web Audio decode path. */
export const MIDI_EXTENSIONS = /\.(mid|midi)$/i;

const MIDI_MIMES = new Set(['audio/midi', 'audio/x-midi', 'audio/mid']);
const MEDIA_SNIFF_TIMEOUT_MS = 5000;

function createSniffAbortError() {
  return typeof DOMException !== 'undefined'
    ? new DOMException('Media validation cancelled', 'AbortError')
    : Object.assign(new Error('Media validation cancelled'), { name: 'AbortError', code: 'ABORT_ERR' });
}

function readBlobHead(blob, options = {}) {
  const signal = options.signal || null;
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? Number(options.timeoutMs)
    : MEDIA_SNIFF_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const cleanup = () => {
      if (timer != null) clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
    };
    const settle = (callback) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const onAbort = () => settle(() => reject(createSniffAbortError()));

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener?.('abort', onAbort, { once: true });
    timer = setTimeout(() => {
      const error = new Error('Media signature read timed out');
      error.name = 'TimeoutError';
      error.code = 'MEDIA_SNIFF_TIMEOUT';
      settle(() => reject(error));
    }, timeoutMs);

    let pending;
    try {
      pending = blob.slice(0, 32).arrayBuffer();
    } catch (error) {
      settle(() => reject(error));
      return;
    }
    Promise.resolve(pending).then(
      (value) => settle(() => resolve(value)),
      (error) => settle(() => reject(error)),
    );
  });
}

/** Explicit MIME list for <input type="file" accept="…"> (desktop / mobile web). */
export const FILE_INPUT_ACCEPT = [
  'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/wave',
  'audio/ogg', 'audio/flac', 'audio/x-flac', 'audio/aac', 'audio/x-aac',
  'audio/x-m4a', 'audio/m4a', 'audio/mp4', 'audio/webm', 'audio/amr',
  'audio/aiff', 'audio/x-aiff', 'audio/x-caf', 'audio/x-ms-wma',
  'audio/opus', 'audio/x-opus+ogg', 'audio/ac3', 'audio/eac3',
  'video/mp4', 'video/webm', 'video/quicktime', 'video/x-msvideo',
  'video/x-matroska', 'video/ogg', 'video/3gpp', 'video/3gpp2',
  'video/x-ms-wmv', 'video/mpeg', 'video/mp2t', 'video/x-flv',
  'audio/*', 'video/*',
  '.wav', '.wave', '.mp3', '.m4a', '.aac', '.ogg', '.oga', '.opus',
  '.flac', '.webm', '.weba', '.aiff', '.aif', '.caf', '.wma', '.mka',
  '.m4b', '.m4r', '.amr', '.3ga', '.ape', '.wv', '.ac3', '.eac3',
  '.mp4', '.m4v', '.mov', '.mkv', '.avi', '.ogv', '.3gp', '.3g2',
  '.wmv', '.mpeg', '.mpg', '.ts', '.m2ts', '.mts', '.flv', '.f4v', '.asf',
].join(',');

/**
 * Compact accept for Capacitor Android WebView.
 * Capacitor BridgeWebChromeClient remaps multi-type accept via EXTRA_MIME_TYPES;
 * a 70+ entry list (many unknown extensions) breaks OEM file pickers.
 * Wildcards keep audio/video selectable without choking Intent extras.
 */
export const FILE_INPUT_ACCEPT_ANDROID_NATIVE = 'audio/*,video/*';

/**
 * @param {object} [opts]
 * @param {boolean} [opts.forceAndroidNative]
 * @returns {string}
 */
export function getFileInputAccept(opts = {}) {
  if (opts.forceAndroidNative === true) return FILE_INPUT_ACCEPT_ANDROID_NATIVE;
  try {
    const cap = globalThis.Capacitor;
    if (cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform()) {
      const platform = typeof cap.getPlatform === 'function' ? cap.getPlatform() : '';
      if (platform === 'android' || /Android/i.test(globalThis.navigator?.userAgent || '')) {
        return FILE_INPUT_ACCEPT_ANDROID_NATIVE;
      }
    }
  } catch { /* ignore */ }
  if (typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent || '')
      && /; wv\)|Version\/\d+\.\d+ Chrome\/\d+.*Mobile/i.test(navigator.userAgent || '')) {
    // Android WebView UA (Capacitor) even before Capacitor global is ready
    return FILE_INPUT_ACCEPT_ANDROID_NATIVE;
  }
  return FILE_INPUT_ACCEPT;
}

/** Native open-dialog extension lists (Electron). */
export const AUDIO_OPEN_EXTENSIONS = [
  'wav', 'wave', 'mp3', 'flac', 'ogg', 'oga', 'opus', 'm4a', 'aac', 'webm', 'weba',
  'aiff', 'aif', 'caf', 'wma', 'mka', 'm4b', 'm4r', 'amr', '3ga', 'ape', 'wv', 'ac3', 'eac3',
];
export const VIDEO_OPEN_EXTENSIONS = [
  'mp4', 'm4v', 'mov', 'mkv', 'avi', 'ogv', '3gp', '3g2', 'wmv', 'mpeg', 'mpg', 'webm',
  'ts', 'm2ts', 'mts', 'flv', 'f4v', 'asf',
];

/** MIME types that do not identify a container (Windows Explorer / some browsers). */
export const GENERIC_MIME_TYPES = new Set([
  '',
  'application/octet-stream',
  'binary/octet-stream',
  'application/x-download',
  'application/force-download',
  'application/unknown',
  'unknown',
]);

/**
 * True when the browser/OS gave no useful content type (decoder must decide).
 * @param {string|null|undefined} type
 * @returns {boolean}
 */
export function isGenericMimeType(type) {
  const t = (type || '').toLowerCase().trim();
  return !t || GENERIC_MIME_TYPES.has(t);
}

/**
 * Infer whether a blob is ingestible audio/video from its MIME type and/or
 * filename extension. Windows often reports `application/octet-stream` or an
 * empty type for otherwise valid media files.
 *
 * @param {Blob|File} blob
 * @returns {'audio'|'video'|'midi'|null}
 */
export function inferMediaKind(blob) {
  const type = (blob?.type || '').toLowerCase();
  const name = blob?.name || '';

  if (MIDI_MIMES.has(type) || MIDI_EXTENSIONS.test(name)) return 'midi';

  // Voice memos labeled video/mp4 — extension wins.
  if (/\.(m4a|m4b|m4r)$/i.test(name)) return 'audio';

  // Ambiguous containers (e.g. .webm): prefer MIME when present.
  if (AMBIGUOUS_MEDIA_EXTENSIONS.test(name)) {
    if (type.startsWith('video/')) return 'video';
    if (type.startsWith('audio/')) return 'audio';
    // Phone voice notes often omit MIME — treat as audio unless proven video later.
    return 'audio';
  }

  // Extension wins over misleading MIME for unambiguous types.
  if (AUDIO_EXTENSIONS.test(name)) return 'audio';
  if (VIDEO_EXTENSIONS.test(name)) return 'video';
  if (type.startsWith('audio/')) return 'audio';
  if (type.startsWith('video/')) return 'video';
  return null;
}

/**
 * Sniff the first bytes of a blob when MIME/extension are useless
 * (e.g. `application/octet-stream` with no extension — common on Windows).
 *
 * @param {Blob|File} blob
 * @param {{ signal?: AbortSignal, timeoutMs?: number }} [options]
 * @returns {Promise<'audio'|'video'|null>}
 */
export async function sniffMediaKind(blob, options = {}) {
  if (!blob || typeof blob.slice !== 'function') return null;
  try {
    const head = new Uint8Array(await readBlobHead(blob, options));
    if (head.length < 4) return null;

    // RIFF....WAVE / AVI / WEBP
    if (head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46) {
      const tag = String.fromCharCode(head[8] || 0, head[9] || 0, head[10] || 0, head[11] || 0);
      if (tag === 'WAVE') return 'audio';
      if (tag === 'AVI ') return 'video';
      if (tag === 'WEBP') return null; // not audio pipeline
      return 'audio'; // other RIFF — try audio decode first
    }

    // OggS (audio/video containers — demuxer decides)
    if (head[0] === 0x4f && head[1] === 0x67 && head[2] === 0x67 && head[3] === 0x53) {
      return 'audio';
    }

    // fLaC
    if (head[0] === 0x66 && head[1] === 0x4c && head[2] === 0x61 && head[3] === 0x43) {
      return 'audio';
    }

    // ID3 tag (MP3) or MPEG audio frame sync
    if (head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) return 'audio';
    if (head[0] === 0xff && (head[1] & 0xe0) === 0xe0) return 'audio';

    // ISO BMFF: ....ftyp.... (MP4 / M4A / MOV)
    if (head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70) {
      const brand = String.fromCharCode(head[8] || 0, head[9] || 0, head[10] || 0, head[11] || 0);
      if (/^(M4A |M4B |M4P |mp3 )/i.test(brand)) return 'audio';
      // qt / isom / mp41 / mp42 — often video; decoder path handles audio-only mp4
      return 'video';
    }

    // EBML (WebM / MKV)
    if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) {
      return 'video';
    }

    // CAF
    if (head[0] === 0x63 && head[1] === 0x61 && head[2] === 0x66 && head[3] === 0x66) {
      return 'audio';
    }

    return null;
  } catch (error) {
    if (error?.name === 'AbortError' || error?.code === 'MEDIA_SNIFF_TIMEOUT') throw error;
    return null;
  }
}

/**
 * Resolve media kind: MIME/extension first, then magic-byte sniff for generic types.
 * @param {Blob|File} blob
 * @param {{ signal?: AbortSignal, timeoutMs?: number }} [options]
 * @returns {Promise<'audio'|'video'|'midi'|null>}
 */
export async function resolveMediaKind(blob, options = {}) {
  const quick = inferMediaKind(blob);
  if (quick) return quick;
  if (!isGenericMimeType(blob?.type) && blob?.type) {
    // Explicit non-media MIME without a recognized extension — reject.
    return null;
  }
  return sniffMediaKind(blob, options);
}

/**
 * True when the source should drive the picture preview and video remux export.
 * Slightly broader than `inferMediaKind === 'video'` so video/* MIME wins for
 * containers like .webm that can also be pure audio.
 *
 * @param {Blob|File|null|undefined} blob
 * @returns {boolean}
 */
export function isVideoSource(blob) {
  if (!blob) return false;
  const type = (blob.type || '').toLowerCase();
  const name = blob.name || '';
  // Voice memos mislabeled as video/mp4.
  if (/\.(m4a|m4b|m4r)$/i.test(name)) return false;
  // Explicit audio MIME wins for ambiguous containers (e.g. audio/webm notes).
  // Exception: .mp4/.mov sometimes report audio/mp4 but still have a picture track.
  if (type.startsWith('audio/') && !/\.(mp4|m4v|mov)$/i.test(name)) return false;
  if (type.startsWith('video/')) return true;
  if (inferMediaKind(blob) === 'video') return true;
  if (/\.(mp4|m4v|mov)$/i.test(name) && (type === 'audio/mp4' || type === 'audio/x-m4a' || !type)) {
    return true;
  }
  return VIDEO_EXTENSIONS.test(name) && !AUDIO_EXTENSIONS.test(name) && !type.startsWith('audio/');
}

/**
 * @param {Blob|File} blob
 * @returns {boolean}
 */
export function isIngestibleMedia(blob) {
  return inferMediaKind(blob) === 'audio' || inferMediaKind(blob) === 'video';
}

export default {
  inferMediaKind,
  sniffMediaKind,
  resolveMediaKind,
  isGenericMimeType,
  isVideoSource,
  isIngestibleMedia,
  AUDIO_EXTENSIONS,
  VIDEO_EXTENSIONS,
  AMBIGUOUS_MEDIA_EXTENSIONS,
  GENERIC_MIME_TYPES,
  FILE_INPUT_ACCEPT,
  FILE_INPUT_ACCEPT_ANDROID_NATIVE,
  getFileInputAccept,
  AUDIO_OPEN_EXTENSIONS,
  VIDEO_OPEN_EXTENSIONS,
};
