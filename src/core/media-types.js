'use strict';

/** Common audio container extensions browsers can demux via decodeAudioData. */
export const AUDIO_EXTENSIONS = /\.(wav|wave|mp3|m4a|aac|ogg|opus|flac|webm|wma|aiff?|caf|mka)$/i;

/** Common video container extensions (audio track extracted via decodeAudioData). */
export const VIDEO_EXTENSIONS = /\.(mp4|m4v|mov|mkv|avi|ogv|3gp|wmv|mpeg|mpg)$/i;

/** MIDI is never supported by the Web Audio decode path. */
export const MIDI_EXTENSIONS = /\.(mid|midi)$/i;

const MIDI_MIMES = new Set(['audio/midi', 'audio/x-midi', 'audio/mid']);

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

export default { inferMediaKind, isIngestibleMedia, AUDIO_EXTENSIONS, VIDEO_EXTENSIONS };