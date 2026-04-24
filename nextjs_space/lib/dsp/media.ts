// Utilities for extracting audio from audio and video files using the WebAudio API.

export async function decodeAudioFromFile(file: File): Promise<{
  buffer: AudioBuffer;
  durationSec: number;
  channels: number;
  sampleRate: number;
}> {
  const arrayBuffer = await file.arrayBuffer();
  // Detached copy because decodeAudioData transfers the buffer in some browsers
  const copy = arrayBuffer.slice(0);
  const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
  try {
    const buffer = await new Promise<AudioBuffer>((resolve, reject) => {
      ctx.decodeAudioData(copy, resolve, reject);
    });
    return {
      buffer,
      durationSec: buffer.duration,
      channels: buffer.numberOfChannels,
      sampleRate: buffer.sampleRate,
    };
  } finally {
    try {
      await ctx.close();
    } catch {}
  }
}

export function formatTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export const ACCEPTED_TYPES =
  'audio/mpeg,audio/wav,audio/x-wav,audio/ogg,audio/mp4,audio/x-m4a,audio/aac,audio/flac,audio/webm,video/mp4,video/quicktime,video/webm,video/x-matroska,.mp3,.wav,.ogg,.m4a,.aac,.flac,.mp4,.mov,.mkv,.webm';

export function isAcceptedFile(file: File): boolean {
  const name = file.name.toLowerCase();
  const exts = ['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac', '.mp4', '.mov', '.mkv', '.webm'];
  if (exts.some((e) => name.endsWith(e))) return true;
  return (file.type ?? '').startsWith('audio/') || (file.type ?? '').startsWith('video/');
}
