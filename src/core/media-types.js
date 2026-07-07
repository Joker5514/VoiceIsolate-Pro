'use strict';

/** Common audio container extensions browsers can demux via decodeAudioData or media element. */
export const AUDIO_EXTENSIONS = /\.(wav|wave|mp3|m4a|aac|ogg|oga|opus|flac|webm|weba|wma|aiff?|caf|mka|m4b|m4r|amr|3ga|ape|wv|tta|ac3|eac3|dts)$/i;

/** Common video container extensions (audio track extracted via decode or media element). */
export const VIDEO_EXTENSIONS = /\.(mp4|m4v|mov|mkv|avi|ogv|3gp|3g2|wmv|mpeg|mpg|webm|ts|m2ts|mts|flv|f4v|asf|divx)$/i;

/** MIDI is never supported by the Web Audio decode path. */
export const MIDI_EXTENSIONS = /\.(mid|midi)$/i;

const MIDI_MIMES = new Set(['audio/midi', 'audio/x-midi', 'audio/mid']);

/** Explicit MIME list for <input type="file" accept="…"> (iOS/Android pickers). */
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

/** Native open-dialog extension lists (Electron). */
export const AUDIO_OPEN_EXTENSIONS = [
  'wav', 'wave', 'mp3', 'flac', 'ogg', 'oga', 'opus', 'm4a', 'aac', 'webm', 'weba',
  'aiff', 'aif', 'caf', 'wma', 'mka', 'm4b', 'm4r', 'amr', '3ga', 'ape', 'wv', 'ac3', 'eac3',
];
export const VIDEO_OPEN_EXTENSIONS = [
  'mp4', 'm4v', 'mov', 'mkv', 'avi', 'ogv', '3gp', '3g2', 'wmv', 'mpeg', 'mpg', 'webm',
  'ts', 'm2ts', 'mts', 'flv', 'f4v', 'asf',
];

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
  // Extension wins over misleading MIME (e.g. .m4a reported as video/mp4).
  if (AUDIO_EXTENSIONS.test(name)) return 'audio';
  if (VIDEO_EXTENSIONS.test(name)) return 'video';
  if (type.startsWith('audio/')) return 'audio';
  if (type.startsWith('video/')) return 'video';
  return null;
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
  isIngestibleMedia,
  AUDIO_EXTENSIONS,
  VIDEO_EXTENSIONS,
  FILE_INPUT_ACCEPT,
  AUDIO_OPEN_EXTENSIONS,
  VIDEO_OPEN_EXTENSIONS,
};