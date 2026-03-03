/**
 * VoiceIsolate Pro v14.0 – DecodeWorker
 * ─────────────────────────────────────────────────────────
 * Web Worker that decodes audio from any container/codec using ffmpeg.wasm.
 * Supports: MP3, WAV, OGG, FLAC, M4A, AAC, MP4, MOV, WEBM, MKV, AVI, WMA, OPUS
 *
 * Install peer dep:  npm i @ffmpeg/ffmpeg @ffmpeg/util
 *
 * The worker communicates via the WorkerPool protocol:
 *   ← { type: 'init', config: DecodeWorkerConfig }
 *   → { type: 'ready' }
 *   ← { taskId, payload: DecodePayload }
 *   → { taskId, result: DecodeResult, workerIndex, processedMs }
 *   → { taskId, error: string, workerIndex, processedMs }
 *
 * Progress events:
 *   → { type: 'progress', taskId, stage, pct }
 */

import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface DecodeWorkerConfig {
  /** CDN base for ffmpeg.wasm core (optional, uses jsDelivr default) */
  ffmpegCoreUrl?: string;
  /** Target sample rate for resampling output (default: 48000) */
  defaultOutputSr?: number;
  /** Max file size in bytes to accept (default: 2GB) */
  maxFileSizeBytes?: number;
}

export interface DecodePayload {
  /** Raw file bytes */
  fileBuffer: ArrayBuffer;
  /** Original filename with extension – used to detect container */
  fileName: string;
  /** Target sample rate; 0 = preserve original */
  outputSr?: number;
  /** Target channel count; 0 = preserve original; 1 = force mono */
  outputChannels?: number;
  /** Normalise output to peak -1dBFS (default: false) */
  normalize?: boolean;
  /** Trim silence from start/end (threshold dBFS, default: no trim) */
  trimSilenceDB?: number;
  /** Unique task id (set by WorkerPool) */
  taskId?: string;
}

export interface DecodeResult {
  /** Interleaved float32 PCM [-1, 1] */
  pcm: Float32Array;
  sampleRate: number;
  channels: number;
  durationSec: number;
  /** Detected codec (from ffprobe-lite) */
  codec: string;
  /** Detected container */
  container: string;
  /** Peak amplitude before normalisation */
  peakAmplitude: number;
  processedMs: number;
}

// ─── Supported format map ────────────────────────────────────────────────────

const EXTENSION_MAP: Record<string, { inputFmt: string; codec: string }> = {
  mp3:  { inputFmt: 'mp3',     codec: 'libmp3lame' },
  wav:  { inputFmt: 'wav',     codec: 'pcm_s16le'  },
  wave: { inputFmt: 'wav',     codec: 'pcm_s16le'  },
  ogg:  { inputFmt: 'ogg',     codec: 'libvorbis'  },
  oga:  { inputFmt: 'ogg',     codec: 'libvorbis'  },
  flac: { inputFmt: 'flac',    codec: 'flac'        },
  m4a:  { inputFmt: 'mp4',     codec: 'aac'         },
  aac:  { inputFmt: 'aac',     codec: 'aac'         },
  mp4:  { inputFmt: 'mp4',     codec: 'aac'         },
  mov:  { inputFmt: 'mov',     codec: 'aac'         },
  webm: { inputFmt: 'webm',    codec: 'libvorbis'   },
  weba: { inputFmt: 'webm',    codec: 'libvorbis'   },
  mkv:  { inputFmt: 'matroska',codec: 'aac'         },
  avi:  { inputFmt: 'avi',     codec: 'mp3'         },
  wma:  { inputFmt: 'asf',     codec: 'wmav2'       },
  opus: { inputFmt: 'ogg',     codec: 'libopus'     },
  caf:  { inputFmt: 'caf',     codec: 'aac'         },
  aiff: { inputFmt: 'aiff',    codec: 'pcm_s16le'   },
  aif:  { inputFmt: 'aiff',    codec: 'pcm_s16le'   },
};

// ─── Worker state ─────────────────────────────────────────────────────────────

let ffmpeg: FFmpeg | null = null;
let config: Required<DecodeWorkerConfig>;
let workerIndex = 0; // set from init message or 0
let isReady = false;

// ─── Init ─────────────────────────────────────────────────────────────────────

async function initFFmpeg(cfg: DecodeWorkerConfig): Promise<void> {
  config = {
    ffmpegCoreUrl:    cfg.ffmpegCoreUrl    ?? 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm',
    defaultOutputSr:  cfg.defaultOutputSr  ?? 48000,
    maxFileSizeBytes: cfg.maxFileSizeBytes  ?? 2 * 1024 * 1024 * 1024,
  };

  ffmpeg = new FFmpeg();

  ffmpeg.on('log', ({ message }) => {
    if (message.includes('Error') || message.includes('error')) {
      console.warn('[decode-worker] ffmpeg:', message);
    }
  });

  const baseUrl = config.ffmpegCoreUrl;
  await ffmpeg.load({
    coreURL:   await toBlobURL(`${baseUrl}/ffmpeg-core.js`,   'text/javascript'),
    wasmURL:   await toBlobURL(`${baseUrl}/ffmpeg-core.wasm`, 'application/wasm'),
  });
}

// ─── Decode pipeline ──────────────────────────────────────────────────────────

async function decode(payload: DecodePayload, taskId: string): Promise<DecodeResult> {
  if (!ffmpeg) throw new Error('FFmpeg not initialised');

  const startMs = performance.now();
  const { fileBuffer, fileName, outputSr = config.defaultOutputSr,
          outputChannels = 1, normalize = false, trimSilenceDB } = payload;

  // Validate size
  if (fileBuffer.byteLength > config.maxFileSizeBytes) {
    throw new Error(`File too large: ${fileBuffer.byteLength} bytes (max ${config.maxFileSizeBytes})`);
  }

  // Determine extension & sanitize to prevent injection
  const ext = (fileName.split('.').pop()?.toLowerCase() ?? '').replace(/[^a-z0-9]/g, '').slice(0, 10);
  const fmt = EXTENSION_MAP[ext] ?? { inputFmt: 'auto', codec: 'unknown' };

  postProgress(taskId, 'detect', 5);

  // Write input file to ffmpeg virtual FS
  const inName = `input.${ext || 'bin'}`;
  await ffmpeg.writeFile(inName, new Uint8Array(fileBuffer));

  postProgress(taskId, 'write', 15);

  // Build ffmpeg command
  // Output: raw f32le PCM so we can read it directly
  const outName = 'output.pcm';

  // Validate numeric inputs
  const safeChannels = Number.isFinite(Number(outputChannels)) && (outputChannels ?? 0) > 0 ? outputChannels : 1;
  const safeSr       = Number.isFinite(Number(outputSr)) && (outputSr ?? 0) > 0 ? outputSr : config.defaultOutputSr;

  const args: string[] = [
    '-i', inName,
    '-vn',                   // drop video
    '-ac', String(safeChannels),
  ];

  if (safeSr) args.push('-ar', String(safeSr));

  // Apply silence trim if requested
  if (trimSilenceDB !== undefined) {
    const t = Number(trimSilenceDB);
    if (Number.isFinite(t)) {
      args.push(
        '-af',
        `silenceremove=start_periods=1:start_duration=0.1:start_threshold=${t}dB:detection=peak,` +
        `areverse,silenceremove=start_periods=1:start_duration=0.1:start_threshold=${t}dB:detection=peak,areverse`
      );
    }
  }

  args.push('-f', 'f32le', '-acodec', 'pcm_f32le', outName, '-y');

  postProgress(taskId, 'decode', 25);

  try {
    await ffmpeg.exec(args);
  } catch (e) {
    // Clean up and rethrow
    await safeDelete(ffmpeg, inName);
    throw new Error(`ffmpeg exec failed: ${(e as Error).message}`);
  }

  postProgress(taskId, 'read', 75);

  // Read raw PCM back
  const rawData = await ffmpeg.readFile(outName) as Uint8Array;

  // Clean up virtual FS
  await safeDelete(ffmpeg, inName);
  await safeDelete(ffmpeg, outName);

  postProgress(taskId, 'convert', 85);

  // rawData is Uint8Array of little-endian float32
  const pcm = new Float32Array(
    rawData.buffer,
    rawData.byteOffset,
    rawData.byteLength / 4
  ).slice(); // detach from shared buffer

  // Detect codec from extension map
  const codec     = fmt.codec;
  const container = fmt.inputFmt;

  // Compute peak
  let peak = 0;
  for (let i = 0; i < pcm.length; i++) {
    const abs = Math.abs(pcm[i]);
    if (abs > peak) peak = abs;
  }

  // Normalize
  if (normalize && peak > 0) {
    const targetPeak = 10 ** (-1 / 20); // -1 dBFS
    const scale = targetPeak / peak;
    for (let i = 0; i < pcm.length; i++) pcm[i] *= scale;
  }

  // Clip guard
  for (let i = 0; i < pcm.length; i++) {
    if (pcm[i] > 1) pcm[i] = 1;
    else if (pcm[i] < -1) pcm[i] = -1;
  }

  const actualSr    = outputSr || config.defaultOutputSr;
  const actualCh    = outputChannels || 1;
  const durationSec = pcm.length / actualCh / actualSr;
  const processedMs = performance.now() - startMs;

  postProgress(taskId, 'done', 100);

  return {
    pcm,
    sampleRate: actualSr,
    channels:   actualCh,
    durationSec,
    codec,
    container,
    peakAmplitude: peak,
    processedMs,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function safeDelete(ff: FFmpeg, name: string): Promise<void> {
  try { await ff.deleteFile(name); } catch { /* ignore */ }
}

function postProgress(taskId: string, stage: string, pct: number): void {
  self.postMessage({ type: 'progress', taskId, stage, pct });
}

// ─── Message handler ──────────────────────────────────────────────────────────

self.onmessage = async (ev: MessageEvent) => {
  const data = ev.data;

  // ── Init ──
  if (data?.type === 'init') {
    try {
      workerIndex = data.workerIndex ?? 0;
      await initFFmpeg(data.config ?? {});
      isReady = true;
      self.postMessage({ type: 'ready' });
    } catch (e) {
      self.postMessage({ type: 'error', error: (e as Error).message });
    }
    return;
  }

  // ── Auto-init if no init message was sent (permissive mode) ──
  if (!isReady) {
    try {
      await initFFmpeg({});
      isReady = true;
      self.postMessage({ type: 'ready' });
    } catch (e) {
      self.postMessage({ type: 'error', error: (e as Error).message });
      return;
    }
  }

  // ── Task dispatch ──
  const { taskId, payload } = data as { taskId: string; payload: DecodePayload };
  if (!taskId || !payload) return;

  const t0 = performance.now();
  try {
    const result = await decode({ ...payload, taskId }, taskId);
    // Transfer the PCM ArrayBuffer for zero-copy
    self.postMessage(
      {
        taskId,
        result,
        workerIndex,
        processedMs: performance.now() - t0,
      } satisfies { taskId: string; result: DecodeResult; workerIndex: number; processedMs: number },
      [result.pcm.buffer]
    );
  } catch (e) {
    self.postMessage({
      taskId,
      error:       (e as Error).message,
      workerIndex,
      processedMs: performance.now() - t0,
    });
  }
};

// ─── Batch decode helper (used internally for multi-track projects) ───────────

/**
 * Decode multiple files in sequence (single worker, sequential to avoid memory spikes).
 * Called via dedicated message: { type: 'batchDecode', files: DecodePayload[] }
 */
async function batchDecode(files: DecodePayload[]): Promise<DecodeResult[]> {
  const results: DecodeResult[] = [];
  for (const f of files) {
    const r = await decode(f, f.taskId ?? 'batch');
    results.push(r);
  }
  return results;
}

// ─── Probe helper (returns metadata without full decode) ──────────────────────

async function probe(fileBuffer: ArrayBuffer, fileName: string): Promise<{
  codec: string;
  container: string;
  durationSec: number;
  sampleRate: number;
  channels: number;
}> {
  if (!ffmpeg) throw new Error('FFmpeg not initialised');
  // Sanitize extension to prevent injection
  const ext = (fileName.split('.').pop()?.toLowerCase() ?? '').replace(/[^a-z0-9]/g, '').slice(0, 10);
  const inName = `probe.${ext || 'bin'}`;
  await ffmpeg.writeFile(inName, new Uint8Array(fileBuffer));

  // ffprobe equivalent: decode 0 frames, capture stats via log
  let logOutput = '';
  ffmpeg.on('log', ({ message }) => { logOutput += message + '\n'; });

  try {
    await ffmpeg.exec(['-i', inName, '-f', 'null', '-']);
  } catch { /* ffmpeg exits non-zero for -f null */ }

  await safeDelete(ffmpeg, inName);

  // Parse relevant fields from log
  const srMatch     = logOutput.match(/(\d+) Hz/);
  const chMatch     = logOutput.match(/(\d+) channels?/i) ?? logOutput.match(/, (stereo|mono),/);
  const durMatch    = logOutput.match(/Duration: (\d+):(\d+):(\d+\.\d+)/);
  const codecMatch  = logOutput.match(/Audio: (\w+)/);
  const fmtMatch    = EXTENSION_MAP[ext];

  const durationSec = durMatch
    ? parseInt(durMatch[1]) * 3600 + parseInt(durMatch[2]) * 60 + parseFloat(durMatch[3])
    : 0;
  const channels = chMatch
    ? (chMatch[1] === 'stereo' ? 2 : chMatch[1] === 'mono' ? 1 : parseInt(chMatch[1]))
    : 1;

  return {
    codec:       codecMatch?.[1] ?? fmtMatch?.codec ?? 'unknown',
    container:   fmtMatch?.inputFmt ?? ext,
    durationSec,
    sampleRate:  srMatch ? parseInt(srMatch[1]) : 0,
    channels,
  };
}

// Expose probe via message
const _origOnMessage = self.onmessage;
self.onmessage = async (ev: MessageEvent) => {
  if (ev.data?.type === 'probe') {
    try {
      if (!isReady) { await initFFmpeg({}); isReady = true; self.postMessage({ type: 'ready' }); }
      const meta = await probe(ev.data.fileBuffer, ev.data.fileName);
      self.postMessage({ type: 'probeResult', taskId: ev.data.taskId, meta });
    } catch (e) {
      self.postMessage({ type: 'probeResult', taskId: ev.data.taskId, error: (e as Error).message });
    }
    return;
  }
  if (ev.data?.type === 'batchDecode') {
    try {
      const results = await batchDecode(ev.data.files);
      self.postMessage({ type: 'batchResult', taskId: ev.data.taskId, results });
    } catch (e) {
      self.postMessage({ type: 'batchResult', taskId: ev.data.taskId, error: (e as Error).message });
    }
    return;
  }
  _origOnMessage?.call(self, ev);
};
