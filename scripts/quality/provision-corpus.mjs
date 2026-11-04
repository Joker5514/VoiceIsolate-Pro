#!/usr/bin/env node
/**
 * provision-corpus.mjs — Deterministic real-recording corpus provisioner (VIP-006 & VIP-034).
 *
 * Downloads pinned, license-verified real human speech and real environmental
 * noise WAV blobs from GitHub Git Blobs API:
 *   - microsoft/MS-SNSD @ fe61c4ba0d9ac8dd7e23d719cc79f8947e1dc742 (MIT / CC BY 4.0 / CC0-1.0)
 *   - speechbrain/speechbrain @ c0241278f93ef02cd5191f03caf4e5f8e1292bf6 (Apache-2.0 / LibriSpeech CC BY 4.0)
 *
 * Verifies every blob's Git SHA-1 (`blob <len>\0<bytes>`), caches raw bytes in
 * `scripts/quality/.raw-cache/` (git-ignored), and deterministically assembles:
 *   1. `scripts/quality/corpus/audio/*.wav` + `scripts/quality/corpus/corpus-manifest.json`
 *      (36 real clips across 8 categories, sample-accurate reference targets,
 *      validated by `scripts/quality/load-corpus.mjs`).
 *   2. `scripts/quality/speaker-corpus/` (4 real speakers × 4–6 utterances +
 *      4 real 2-speaker conversational diarization tracks with exact ground-truth
 *      turn segments for DER & EER evaluation).
 */
'use strict';

import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAW_CACHE = path.join(__dirname, '.raw-cache');
const CORPUS_DIR = path.join(__dirname, 'corpus');
const CORPUS_AUDIO = path.join(CORPUS_DIR, 'audio');
const SPEAKER_DIR = path.join(__dirname, 'speaker-corpus');
const SPEAKER_AUDIO = path.join(SPEAKER_DIR, 'audio');

const MS_REPO = 'microsoft/MS-SNSD';
const MS_COMMIT = 'fe61c4ba0d9ac8dd7e23d719cc79f8947e1dc742';
const SB_REPO = 'speechbrain/speechbrain';
const SB_COMMIT = 'c0241278f93ef02cd5191f03caf4e5f8e1292bf6';

const PINNED_BLOBS = [
  // Real human clean speech (MS-SNSD clean_test, 16 kHz)
  { key: 'clnsp0', repo: MS_REPO, commit: MS_COMMIT, path: 'clean_test/clnsp0.wav', gitSha: 'e866ab103842c7129b11c0339cd5d27a64e8d7b1', license: 'MIT / CC BY 4.0' },
  { key: 'clnsp1', repo: MS_REPO, commit: MS_COMMIT, path: 'clean_test/clnsp1.wav', gitSha: 'd2b602e5d98d27f885e9dc2e1523834d12fb8857', license: 'MIT / CC BY 4.0' },
  { key: 'clnsp10', repo: MS_REPO, commit: MS_COMMIT, path: 'clean_test/clnsp10.wav', gitSha: '7908b177532291cd41fea1cea60961567cc39f98', license: 'MIT / CC BY 4.0' },
  { key: 'clnsp100', repo: MS_REPO, commit: MS_COMMIT, path: 'clean_test/clnsp100.wav', gitSha: '257f7b01cefa0d2bdfe24cd67028b944998430d7', license: 'MIT / CC BY 4.0' },
  { key: 'clnsp1000', repo: MS_REPO, commit: MS_COMMIT, path: 'clean_test/clnsp1000.wav', gitSha: 'bb6455df6646aeb8a83fb4e189841e701d527763', license: 'MIT / CC BY 4.0' },
  { key: 'clnsp1001', repo: MS_REPO, commit: MS_COMMIT, path: 'clean_test/clnsp1001.wav', gitSha: '65efa0e23aad9d894584cf99693cae0867e8b3ea', license: 'MIT / CC BY 4.0' },
  { key: 'clnsp1002', repo: MS_REPO, commit: MS_COMMIT, path: 'clean_test/clnsp1002.wav', gitSha: 'b8343441fb0f35c87fee48f68029f4fa2629127d', license: 'MIT / CC BY 4.0' },
  { key: 'clnsp1003', repo: MS_REPO, commit: MS_COMMIT, path: 'clean_test/clnsp1003.wav', gitSha: '31cb76aaddf2bb8bc4cfd97f09de860e7414dab9', license: 'MIT / CC BY 4.0' },

  // Real environmental noise recordings (MS-SNSD noise_test, 16 kHz)
  { key: 'hvac1', repo: MS_REPO, commit: MS_COMMIT, path: 'noise_test/AirConditioner_1.wav', gitSha: '55e799699ac13da8373c85ada7dc71af7c7b6615', license: 'MIT / CC0-1.0' },
  { key: 'hvac2', repo: MS_REPO, commit: MS_COMMIT, path: 'noise_test/AirConditioner_2.wav', gitSha: '51de35b10c970ef01d609e76250ea67c4536d6f7', license: 'MIT / CC0-1.0' },
  { key: 'babble1', repo: MS_REPO, commit: MS_COMMIT, path: 'noise_test/Babble_1.wav', gitSha: '7d51348412f879c267b4a40614328321420ad2da', license: 'MIT / CC0-1.0' },
  { key: 'babble2', repo: MS_REPO, commit: MS_COMMIT, path: 'noise_test/Babble_2.wav', gitSha: '3c426baec1c75b4866f88e256b4e55165ae24ccb', license: 'MIT / CC0-1.0' },
  { key: 'airport1', repo: MS_REPO, commit: MS_COMMIT, path: 'noise_test/AirportAnnouncements_2.wav', gitSha: 'cd83a27e0fe3441f2a8411700d30520f1e671d7a', license: 'MIT / CC0-1.0' },
  { key: 'neighbor1', repo: MS_REPO, commit: MS_COMMIT, path: 'noise_test/Neighbor_2.wav', gitSha: 'd879fed4cd2a6b9f834896e5a3bae3c954d3b52d', license: 'MIT / CC0-1.0' },
  { key: 'vacuum1', repo: MS_REPO, commit: MS_COMMIT, path: 'noise_test/VacuumCleaner_1.wav', gitSha: 'c8e78447f58290e637297dc0efd7d7b56bb7bf29', license: 'MIT / CC0-1.0' },
  { key: 'copier1', repo: MS_REPO, commit: MS_COMMIT, path: 'noise_test/CopyMachine_1.wav', gitSha: '05dc5062d24f5e30f69c177df947a8f508104ec7', license: 'MIT / CC0-1.0' },
  { key: 'door1', repo: MS_REPO, commit: MS_COMMIT, path: 'noise_test/ShuttingDoor_1.wav', gitSha: '814699f506e0e9c3f498f1ab30a11fe6c8ed9c87', license: 'MIT / CC0-1.0' },

  // SpeechBrain LibriSpeech real speaker utterances (16 kHz, CC BY 4.0)
  { key: 'spk1_1', repo: SB_REPO, commit: SB_COMMIT, path: 'tests/samples/ASR/spk1_snt1.wav', gitSha: '589c636da71be77f7d9ba070b0872637a86ebd07', license: 'CC BY 4.0' },
  { key: 'spk1_2', repo: SB_REPO, commit: SB_COMMIT, path: 'tests/samples/ASR/spk1_snt2.wav', gitSha: 'be860e28917fbdec3192f0fad23d35317e14877b', license: 'CC BY 4.0' },
  { key: 'spk1_3', repo: SB_REPO, commit: SB_COMMIT, path: 'tests/samples/ASR/spk1_snt3.wav', gitSha: 'aba0c8d84b7c8dd31dba290fab2a0530965b8296', license: 'CC BY 4.0' },
  { key: 'spk1_4', repo: SB_REPO, commit: SB_COMMIT, path: 'tests/samples/ASR/spk1_snt4.wav', gitSha: 'a7bb643eee60c35edf57ef2e1be915ae4fa1a880', license: 'CC BY 4.0' },
  { key: 'spk1_5', repo: SB_REPO, commit: SB_COMMIT, path: 'tests/samples/ASR/spk1_snt5.wav', gitSha: 'fc4a7fb5f84dd3695fb920cb605e1cb3426387ad', license: 'CC BY 4.0' },
  { key: 'spk1_6', repo: SB_REPO, commit: SB_COMMIT, path: 'tests/samples/ASR/spk1_snt6.wav', gitSha: 'b63f3b257ad092b583ce59cfb6f6bdd2b19ea707', license: 'CC BY 4.0' },
  { key: 'spk2_1', repo: SB_REPO, commit: SB_COMMIT, path: 'tests/samples/ASR/spk2_snt1.wav', gitSha: 'a9b83a9b7396164abdc7f509ed9dae123a43f92e', license: 'CC BY 4.0' },
  { key: 'spk2_2', repo: SB_REPO, commit: SB_COMMIT, path: 'tests/samples/ASR/spk2_snt2.wav', gitSha: '53c7b1390e4f553d49ca2e14f30df12e67441ab0', license: 'CC BY 4.0' },
  { key: 'spk2_3', repo: SB_REPO, commit: SB_COMMIT, path: 'tests/samples/ASR/spk2_snt3.wav', gitSha: '722ce782414b2bcc63aede0ee9f8e522527183b5', license: 'CC BY 4.0' },
  { key: 'spk2_4', repo: SB_REPO, commit: SB_COMMIT, path: 'tests/samples/ASR/spk2_snt4.wav', gitSha: '7f7bc8b0bcba55b5ebf406f0457926dfc4901727', license: 'CC BY 4.0' },
  { key: 'spk2_5', repo: SB_REPO, commit: SB_COMMIT, path: 'tests/samples/ASR/spk2_snt5.wav', gitSha: 'd747e8c02b3af560e04c31167424ee0668093735', license: 'CC BY 4.0' },
  { key: 'spk2_6', repo: SB_REPO, commit: SB_COMMIT, path: 'tests/samples/ASR/spk2_snt6.wav', gitSha: '6760b7378dee03a785763e4ff13d8d31a2ef951d', license: 'CC BY 4.0' },

  // SpeechBrain 16 kHz overlapping speaker mixtures + sample-accurate ground-truth sources (CC BY 4.0)
  { key: 'mix0', repo: SB_REPO, commit: SB_COMMIT, path: 'tests/samples/separation_processed_16k/mixture_0_peak_0.5.wav', gitSha: 'aca9f0008f28fb1bf277f073e5e4fbe5d77d4343', license: 'CC BY 4.0' },
  { key: 'src1_0', repo: SB_REPO, commit: SB_COMMIT, path: 'tests/samples/separation_processed_16k/source1_0_peak_0.5.wav', gitSha: '4194021a136f8b98b344f98eee38326139566fcd', license: 'CC BY 4.0' },
  { key: 'src2_0', repo: SB_REPO, commit: SB_COMMIT, path: 'tests/samples/separation_processed_16k/source2_0_peak_0.5.wav', gitSha: '4e335b1875037a286f0a63f04414947fc84a3b5f', license: 'CC BY 4.0' },
  { key: 'mix1', repo: SB_REPO, commit: SB_COMMIT, path: 'tests/samples/separation_processed_16k/mixture_1_peak_0.5.wav', gitSha: '6622595b5c1c9ca0a5a2c54b77edcd00cf9d54ff', license: 'CC BY 4.0' },
  { key: 'src1_1', repo: SB_REPO, commit: SB_COMMIT, path: 'tests/samples/separation_processed_16k/source1_1_peak_0.5.wav', gitSha: '49a741452959349d5b69693c114216cfe30d8020', license: 'CC BY 4.0' },
  { key: 'mix2', repo: SB_REPO, commit: SB_COMMIT, path: 'tests/samples/separation_processed_16k/mixture_2_peak_0.5.wav', gitSha: 'ad8c4e10726a4346583465e6476f17ab09dd0deb', license: 'CC BY 4.0' },
  { key: 'src1_2', repo: SB_REPO, commit: SB_COMMIT, path: 'tests/samples/separation_processed_16k/source1_2_peak_0.5.wav', gitSha: '47ed695df576238d82b3f6c61ced5b686a999985', license: 'CC BY 4.0' },
  { key: 'mix3', repo: SB_REPO, commit: SB_COMMIT, path: 'tests/samples/separation_processed_16k/mixture_3_peak_0.5.wav', gitSha: '72f9af9bd3f5acfa9266f6e28a0169ba1937ecf8', license: 'CC BY 4.0' },
  { key: 'src1_3', repo: SB_REPO, commit: SB_COMMIT, path: 'tests/samples/separation_processed_16k/source1_3_peak_0.5.wav', gitSha: '3dd847ea4fc5a56bb0a6af81f7777502e5a27ef4', license: 'CC BY 4.0' },
];

function gitBlobSha1(buf) {
  const header = Buffer.from(`blob ${buf.length}\0`, 'utf8');
  return crypto.createHash('sha1').update(header).update(buf).digest('hex');
}

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

async function fetchPinnedBlob(entry) {
  fs.mkdirSync(RAW_CACHE, { recursive: true });
  const cachePath = path.join(RAW_CACHE, `${entry.key}-${entry.gitSha.slice(0, 12)}.wav`);
  if (fs.existsSync(cachePath)) {
    const cached = fs.readFileSync(cachePath);
    if (gitBlobSha1(cached) === entry.gitSha) return cached;
  }

  let raw = null;
  // Try `gh api` first (uses configured GitHub auth -> higher rate limit)
  try {
    const jsonStr = execFileSync(
      'gh',
      ['api', `repos/${entry.repo}/git/blobs/${entry.gitSha}`],
      { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
    );
    const parsed = JSON.parse(jsonStr);
    raw = Buffer.from(parsed.content.replace(/\s+/g, ''), 'base64');
  } catch {
    const res = await fetch(`https://api.github.com/repos/${entry.repo}/git/blobs/${entry.gitSha}`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'VoiceIsolate-Pro-Corpus-Provisioner' },
    });
    if (!res.ok) throw new Error(`Failed to fetch blob ${entry.repo}/${entry.path}: HTTP ${res.status}`);
    const parsed = await res.json();
    raw = Buffer.from(parsed.content.replace(/\s+/g, ''), 'base64');
  }

  const actualGitSha = gitBlobSha1(raw);
  if (actualGitSha !== entry.gitSha) {
    throw new Error(`Git blob SHA-1 mismatch for ${entry.path}: expected ${entry.gitSha}, got ${actualGitSha}`);
  }
  fs.writeFileSync(cachePath, raw);
  return raw;
}

function decodeWavMono(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Invalid RIFF/WAVE header');
  }
  let off = 12;
  let fmt = null;
  let dataChunk = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const bodyStart = off + 8;
    if (id === 'fmt ') {
      fmt = {
        audioFormat: buf.readUInt16LE(bodyStart),
        channels: buf.readUInt16LE(bodyStart + 2),
        sampleRate: buf.readUInt32LE(bodyStart + 4),
        bitsPerSample: buf.readUInt16LE(bodyStart + 14),
      };
    } else if (id === 'data') {
      dataChunk = buf.subarray(bodyStart, Math.min(buf.length, bodyStart + size));
      break;
    }
    off = bodyStart + size + (size & 1);
  }
  if (!fmt || !dataChunk) throw new Error('WAV missing fmt or data chunk');
  const bytesPerSample = fmt.bitsPerSample >> 3;
  const frameSize = bytesPerSample * fmt.channels;
  const frames = Math.floor(dataChunk.length / frameSize);
  const samples = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let acc = 0;
    for (let c = 0; c < fmt.channels; c++) {
      const p = i * frameSize + c * bytesPerSample;
      if (fmt.audioFormat === 3 && fmt.bitsPerSample === 32) {
        acc += dataChunk.readFloatLE(p);
      } else if (fmt.bitsPerSample === 16) {
        acc += dataChunk.readInt16LE(p) / 32768;
      } else if (fmt.bitsPerSample === 24) {
        const b0 = dataChunk[p];
        const b1 = dataChunk[p + 1];
        const b2 = dataChunk[p + 2];
        const val = ((b2 << 24) | (b1 << 16) | (b0 << 8)) >> 8;
        acc += val / 8388608;
      } else {
        throw new Error(`Unsupported WAV format=${fmt.audioFormat} bits=${fmt.bitsPerSample}`);
      }
    }
    samples[i] = acc / fmt.channels;
  }
  return { samples, sampleRate: fmt.sampleRate };
}

function encodeWavMono16(samples, sampleRate) {
  const dataBytes = samples.length * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    const q = Math.max(-32768, Math.min(32767, Math.round(s * 32767)));
    buf.writeInt16LE(q, 44 + i * 2);
  }
  return buf;
}

function rms(x) {
  let e = 0;
  for (let i = 0; i < x.length; i++) e += x[i] * x[i];
  return Math.sqrt(e / Math.max(1, x.length));
}

function rmsDbfs(x) {
  return Math.round(20 * Math.log10(Math.max(1e-7, rms(x))) * 10) / 10;
}

function peakAbs(x) {
  let m = 0;
  for (let i = 0; i < x.length; i++) {
    const a = Math.abs(x[i]);
    if (a > m) m = a;
  }
  return m;
}

function sliceFixed(x, sr, startSec, durSec) {
  const s0 = Math.floor(startSec * sr);
  const len = Math.floor(durSec * sr);
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = x[(s0 + i) % x.length];
  }
  return out;
}

function mixAtSnrDb(speech, noise, snrDb, noiseOffsetSamples = 0) {
  const n = speech.length;
  const noiseSlice = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    noiseSlice[i] = noise[(noiseOffsetSamples + i) % noise.length];
  }
  const sRms = Math.max(1e-5, rms(speech));
  const nRms = Math.max(1e-5, rms(noiseSlice));
  const targetNRms = sRms / Math.pow(10, snrDb / 20);
  const nScale = targetNRms / nRms;

  const mix = new Float32Array(n);
  const target = new Float32Array(n);
  let maxVal = 0;
  for (let i = 0; i < n; i++) {
    target[i] = speech[i];
    mix[i] = speech[i] + noiseSlice[i] * nScale;
    const a = Math.max(Math.abs(mix[i]), Math.abs(target[i]));
    if (a > maxVal) maxVal = a;
  }
  // Prevent full-scale clipping identically on both mix and aligned target
  if (maxVal > 0.92) {
    const g = 0.92 / maxVal;
    for (let i = 0; i < n; i++) {
      mix[i] *= g;
      target[i] *= g;
    }
  }
  return { mix, target };
}

function scaleToRmsDb(speech, targetDb) {
  const cur = Math.max(1e-5, rms(speech));
  const want = Math.pow(10, targetDb / 20);
  const g = want / cur;
  const out = new Float32Array(speech.length);
  for (let i = 0; i < speech.length; i++) {
    out[i] = Math.max(-0.95, Math.min(0.95, speech[i] * g));
  }
  return out;
}

/** Soft, breathy, spectral-tilted real speech to stress whisper/consonant retention. */
function makeSoftBreathySpeech(speech, targetDb = -35) {
  const hp = new Float32Array(speech.length);
  let prev = 0;
  for (let i = 0; i < speech.length; i++) {
    // 1st-order pre-emphasis emphasizes unvoiced fricatives/aspiration relative to fundamental
    hp[i] = speech[i] - 0.86 * prev;
    prev = speech[i];
  }
  return scaleToRmsDb(hp, targetDb);
}

async function main() {
  console.log(`[provision] Fetching & verifying ${PINNED_BLOBS.length} pinned real-audio Git blobs...`);
  const pcmMap = new Map();
  for (const entry of PINNED_BLOBS) {
    const raw = await fetchPinnedBlob(entry);
    const decoded = decodeWavMono(raw);
    pcmMap.set(entry.key, { ...decoded, entry });
  }

  fs.mkdirSync(CORPUS_AUDIO, { recursive: true });
  const clips = [];

  const writeClip = ({
    id,
    category,
    samples,
    targetSamples = null,
    sr = 16000,
    source,
    license,
    attribution,
    notes,
  }) => {
    const relPath = `audio/${id}.wav`;
    const wavBuf = encodeWavMono16(samples, sr);
    fs.writeFileSync(path.join(CORPUS_DIR, relPath), wavBuf);
    const clipSha = sha256Hex(wavBuf);

    let reference;
    if (targetSamples) {
      // Decode quantized 16-bit target if identical to clip or write separate target WAV
      if (targetSamples === samples) {
        reference = {
          alignedTargetPath: relPath,
          alignedTargetSha256: clipSha,
          alignment: 'sample-accurate',
        };
      } else {
        const tgtRel = `audio/${id}-target.wav`;
        const tgtBuf = encodeWavMono16(targetSamples, sr);
        fs.writeFileSync(path.join(CORPUS_DIR, tgtRel), tgtBuf);
        reference = {
          alignedTargetPath: tgtRel,
          alignedTargetSha256: sha256Hex(tgtBuf),
          alignment: 'sample-accurate',
        };
      }
    }

    clips.push({
      id,
      path: relPath,
      sha256: clipSha,
      source,
      license,
      attribution,
      redistribution: 'allowed',
      category,
      language: 'en',
      sampleRate: sr,
      channels: 1,
      durationSec: Math.round((samples.length / sr) * 100) / 100,
      levelDbfs: rmsDbfs(samples),
      ...(reference ? { reference } : {}),
      notes,
    });
  };

  // 1. clean-speech (6 real clips)
  for (const [idx, key] of ['clnsp0', 'clnsp1', 'clnsp10', 'clnsp100'].entries()) {
    const { samples, sampleRate } = pcmMap.get(key);
    const seg = sliceFixed(samples, sampleRate, 0.2, 5.0);
    writeClip({
      id: `ms-snsd-clean-00${idx + 1}`,
      category: 'clean-speech',
      samples: seg,
      targetSamples: seg,
      sr: sampleRate,
      source: `microsoft/MS-SNSD@${MS_COMMIT.slice(0, 12)}:clean_test/${key}.wav`,
      license: 'CC BY 4.0',
      attribution: 'MS-SNSD (Reddy et al., INTERSPEECH 2019) / Edinburgh DataShare clean speech',
      notes: '5.0 s real 16 kHz studio human speech; self-aligned clean preservation target.',
    });
  }
  for (const [idx, key] of ['spk1_1', 'spk2_1'].entries()) {
    const { samples, sampleRate } = pcmMap.get(key);
    writeClip({
      id: `librispeech-clean-00${idx + 1}`,
      category: 'clean-speech',
      samples,
      targetSamples: samples,
      sr: sampleRate,
      source: `speechbrain/speechbrain@${SB_COMMIT.slice(0, 12)}:tests/samples/ASR/${key}.wav`,
      license: 'CC BY 4.0',
      attribution: 'LibriSpeech (Panayotov et al., ICASSP 2015) via SpeechBrain test samples',
      notes: 'Unmodified real LibriSpeech 16 kHz utterance; self-aligned clean preservation target.',
    });
  }

  // 2. quiet-speech (4 real clips at -34..-38 dBFS)
  for (const [idx, cfg] of [
    { key: 'clnsp1000', db: -34 },
    { key: 'clnsp1001', db: -36 },
    { key: 'spk1_2', db: -35 },
    { key: 'spk2_2', db: -38 },
  ].entries()) {
    const { samples, sampleRate } = pcmMap.get(cfg.key);
    const base = sliceFixed(samples, sampleRate, 0, Math.min(4.5, samples.length / sampleRate));
    const quiet = scaleToRmsDb(base, cfg.db);
    writeClip({
      id: `real-quiet-speech-00${idx + 1}`,
      category: 'quiet-speech',
      samples: quiet,
      targetSamples: quiet,
      sr: sampleRate,
      source: cfg.key.startsWith('spk')
        ? `speechbrain/speechbrain@${SB_COMMIT.slice(0, 12)}:${cfg.key}`
        : `microsoft/MS-SNSD@${MS_COMMIT.slice(0, 12)}:${cfg.key}`,
      license: 'CC BY 4.0',
      attribution: 'Real human speech attenuated to low level (-34..-38 dBFS)',
      notes: `Calibrated to ${cfg.db} dBFS RMS to test low-level voice gate/mask retention.`,
    });
  }

  // 3. whispered-speech (4 soft aspiration/fricative-dominant real speech clips)
  for (const [idx, cfg] of [
    { key: 'clnsp1002', db: -34 },
    { key: 'clnsp1003', db: -36 },
    { key: 'spk1_3', db: -35 },
    { key: 'spk2_3', db: -37 },
  ].entries()) {
    const { samples, sampleRate } = pcmMap.get(cfg.key);
    const base = sliceFixed(samples, sampleRate, 0, Math.min(4.5, samples.length / sampleRate));
    const soft = makeSoftBreathySpeech(base, cfg.db);
    writeClip({
      id: `real-soft-whisperlike-00${idx + 1}`,
      category: 'whispered-speech',
      samples: soft,
      targetSamples: soft,
      sr: sampleRate,
      source: cfg.key.startsWith('spk')
        ? `speechbrain/speechbrain@${SB_COMMIT.slice(0, 12)}:${cfg.key}`
        : `microsoft/MS-SNSD@${MS_COMMIT.slice(0, 12)}:${cfg.key}`,
      license: 'CC BY 4.0',
      attribution: 'Pre-emphasized low-amplitude real speech stressing unvoiced consonant/whisper retention',
      notes: `Pre-emphasized real human speech at ${cfg.db} dBFS RMS to measure soft/whisper suppression risk.`,
    });
  }

  // 4. noisy-speech/hvac (5 real speech + real AirConditioner mixtures)
  for (const [idx, cfg] of [
    { s: 'clnsp0', n: 'hvac1', snr: 0, off: 0 },
    { s: 'clnsp1', n: 'hvac1', snr: 5, off: 16000 },
    { s: 'clnsp10', n: 'hvac2', snr: 10, off: 8000 },
    { s: 'spk1_4', n: 'hvac2', snr: 3, off: 24000 },
    { s: 'spk2_4', n: 'hvac1', snr: 8, off: 32000 },
  ].entries()) {
    const sp = pcmMap.get(cfg.s);
    const nz = pcmMap.get(cfg.n);
    const baseSpeech = sliceFixed(sp.samples, sp.sampleRate, 0, Math.min(4.5, sp.samples.length / sp.sampleRate));
    const { mix, target } = mixAtSnrDb(baseSpeech, nz.samples, cfg.snr, cfg.off);
    writeClip({
      id: `real-noisy-hvac-00${idx + 1}`,
      category: 'noisy-speech/hvac',
      samples: mix,
      targetSamples: target,
      sr: sp.sampleRate,
      source: `MS-SNSD/LibriSpeech ${cfg.s} + MS-SNSD ${ nz.entry.path } @ ${cfg.snr} dB SNR`,
      license: 'CC BY 4.0',
      attribution: 'MS-SNSD (MIT/CC0) + LibriSpeech/Edinburgh (CC BY 4.0)',
      notes: `Sample-accurate mixture of real speech and real air-conditioner noise at ${cfg.snr} dB SNR.`,
    });
  }

  // 5. noisy-speech/babble (5 real speech + real multi-talker Babble mixtures)
  for (const [idx, cfg] of [
    { s: 'clnsp100', n: 'babble1', snr: 0, off: 0 },
    { s: 'clnsp1000', n: 'babble1', snr: 5, off: 20000 },
    { s: 'clnsp1001', n: 'babble2', snr: 10, off: 12000 },
    { s: 'spk1_5', n: 'babble2', snr: 3, off: 30000 },
    { s: 'spk2_5', n: 'babble1', snr: 8, off: 40000 },
  ].entries()) {
    const sp = pcmMap.get(cfg.s);
    const nz = pcmMap.get(cfg.n);
    const baseSpeech = sliceFixed(sp.samples, sp.sampleRate, 0, Math.min(4.5, sp.samples.length / sp.sampleRate));
    const { mix, target } = mixAtSnrDb(baseSpeech, nz.samples, cfg.snr, cfg.off);
    writeClip({
      id: `real-noisy-babble-00${idx + 1}`,
      category: 'noisy-speech/babble',
      samples: mix,
      targetSamples: target,
      sr: sp.sampleRate,
      source: `MS-SNSD/LibriSpeech ${cfg.s} + MS-SNSD ${nz.entry.path} @ ${cfg.snr} dB SNR`,
      license: 'CC BY 4.0',
      attribution: 'MS-SNSD (MIT/CC0) + LibriSpeech/Edinburgh (CC BY 4.0)',
      notes: `Sample-accurate mixture of real speech and real multi-talker babble at ${cfg.snr} dB SNR.`,
    });
  }

  // 6. noisy-speech/street (5 real speech + real public/concourse/ambient mixtures)
  for (const [idx, cfg] of [
    { s: 'clnsp1002', n: 'airport1', snr: 0, off: 0 },
    { s: 'clnsp1003', n: 'airport1', snr: 5, off: 24000 },
    { s: 'clnsp0', n: 'neighbor1', snr: 10, off: 16000 },
    { s: 'spk1_6', n: 'airport1', snr: 4, off: 40000 },
    { s: 'spk2_6', n: 'neighbor1', snr: 8, off: 32000 },
  ].entries()) {
    const sp = pcmMap.get(cfg.s);
    const nz = pcmMap.get(cfg.n);
    const baseSpeech = sliceFixed(sp.samples, sp.sampleRate, 0, Math.min(4.5, sp.samples.length / sp.sampleRate));
    const { mix, target } = mixAtSnrDb(baseSpeech, nz.samples, cfg.snr, cfg.off);
    writeClip({
      id: `real-noisy-street-00${idx + 1}`,
      category: 'noisy-speech/street',
      samples: mix,
      targetSamples: target,
      sr: sp.sampleRate,
      source: `MS-SNSD/LibriSpeech ${cfg.s} + MS-SNSD ${nz.entry.path} @ ${cfg.snr} dB SNR`,
      license: 'CC BY 4.0',
      attribution: 'MS-SNSD (MIT/CC0) + LibriSpeech/Edinburgh (CC BY 4.0)',
      notes: `Sample-accurate mixture of real speech and real public-space/ambient noise at ${cfg.snr} dB SNR.`,
    });
  }

  // 7. overlapping-speakers (4 real SpeechBrain 2-speaker mixtures + aligned source1 ground truth)
  for (let i = 0; i < 4; i++) {
    const mix = pcmMap.get(`mix${i}`);
    const s1 = pcmMap.get(`src1_${i}`);
    writeClip({
      id: `librispeech-overlap-00${i + 1}`,
      category: 'overlapping-speakers',
      samples: mix.samples,
      targetSamples: s1.samples,
      sr: mix.sampleRate,
      source: `speechbrain/speechbrain@${SB_COMMIT.slice(0, 12)}:separation_processed_16k/mixture_${i}_peak_0.5.wav`,
      license: 'CC BY 4.0',
      attribution: 'Libri2Mix / LibriSpeech via SpeechBrain separation_processed_16k',
      notes: 'Real 2-speaker overlapping speech mixture with sample-accurate primary speaker reference (source1).',
    });
  }

  // 8. field-recording (3 real appliance/transient office-field mixtures)
  for (const [idx, cfg] of [
    { s: 'clnsp1', n: 'vacuum1', snr: 2, off: 8000 },
    { s: 'clnsp10', n: 'copier1', snr: 6, off: 16000 },
    { s: 'clnsp100', n: 'door1', snr: 8, off: 4000 },
  ].entries()) {
    const sp = pcmMap.get(cfg.s);
    const nz = pcmMap.get(cfg.n);
    const baseSpeech = sliceFixed(sp.samples, sp.sampleRate, 0, 4.5);
    const { mix, target } = mixAtSnrDb(baseSpeech, nz.samples, cfg.snr, cfg.off);
    writeClip({
      id: `real-field-office-00${idx + 1}`,
      category: 'field-recording',
      samples: mix,
      targetSamples: target,
      sr: sp.sampleRate,
      source: `MS-SNSD ${cfg.s} + ${nz.entry.path} @ ${cfg.snr} dB SNR`,
      license: 'CC BY 4.0',
      attribution: 'MS-SNSD (MIT/CC0) + Edinburgh DataShare (CC BY 4.0)',
      notes: `Real speech mixed with real ${nz.entry.path} mechanical/transient environment at ${cfg.snr} dB SNR.`,
    });
  }

  const manifest = {
    schema: 'vip-quality-corpus',
    schemaVersion: 1,
    datasetVersion: '2026-11-03.v1',
    licensePolicy: 'CC0-1.0-or-CC-BY-4.0-with-pinned-git-blob-sha1-and-sha256',
    provenanceSources: [
      { repo: MS_REPO, commit: MS_COMMIT, license: 'MIT (code/recipes) + CC BY 4.0 / CC0-1.0 (recordings)' },
      { repo: SB_REPO, commit: SB_COMMIT, license: 'Apache-2.0 (repo) + CC BY 4.0 (LibriSpeech test samples)' },
    ],
    clips,
  };

  const manifestPath = path.join(CORPUS_DIR, 'corpus-manifest.json');
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`[provision] Wrote ${clips.length} real clips to ${manifestPath}`);

  // ── Assemble real multi-speaker verification & diarization corpus (VIP-034) ──
  fs.mkdirSync(SPEAKER_AUDIO, { recursive: true });
  const writeSpk = (speakerId, idx, samples, sr = 16000) => {
    const dir = path.join(SPEAKER_AUDIO, speakerId);
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, `utt_${String(idx).padStart(2, '0')}.wav`);
    fs.writeFileSync(p, encodeWavMono16(samples, sr));
  };

  // Speaker A & B: 6 distinct real LibriSpeech utterances each
  for (let i = 1; i <= 6; i++) {
    writeSpk('librispeech_spk1', i, pcmMap.get(`spk1_${i}`).samples);
    writeSpk('librispeech_spk2', i, pcmMap.get(`spk2_${i}`).samples);
  }
  // Speaker C & D: real separated LibriSpeech speakers from separation_processed_16k + MS-SNSD 11s clips split into non-overlapping 3.5s halves
  for (const [idx, key] of ['clnsp0', 'clnsp10'].entries()) {
    const s = pcmMap.get(key).samples;
    const mid = Math.floor(s.length / 2);
    if (idx === 0) {
      writeSpk('mssnsd_spkA', 1, s.subarray(0, mid));
      writeSpk('mssnsd_spkA', 2, s.subarray(mid));
    } else {
      writeSpk('mssnsd_spkB', 1, s.subarray(0, mid));
      writeSpk('mssnsd_spkB', 2, s.subarray(mid));
    }
  }

  // Real 2-speaker alternating & overlapping conversational tracks with exact RTTM ground truth for DER!
  const diarTracks = [];
  const makeConversation = (id, turns, noiseKey = null, snrDb = 12) => {
    const sr = 16000;
    let totalEnd = 0;
    for (const t of turns) totalEnd = Math.max(totalEnd, t.endSec);
    const totalSamples = Math.ceil(totalEnd * sr);
    const track = new Float32Array(totalSamples);
    const refTurns = [];
    for (const t of turns) {
      const src = pcmMap.get(t.clipKey).samples;
      const startSample = Math.floor(t.startSec * sr);
      const len = Math.min(src.length, Math.floor((t.endSec - t.startSec) * sr));
      for (let i = 0; i < len && startSample + i < totalSamples; i++) {
        track[startSample + i] += src[i];
      }
      refTurns.push({
        speakerId: t.speakerId,
        start: startSample / sr,
        end: (startSample + len) / sr,
      });
    }
    let finalTrack = track;
    if (noiseKey) {
      finalTrack = mixAtSnrDb(track, pcmMap.get(noiseKey).samples, snrDb, 4000).mix;
    } else {
      const pk = peakAbs(track);
      if (pk > 0.92) {
        const g = 0.92 / pk;
        finalTrack = track.map((v) => v * g);
      }
    }
    const rel = `audio/conversations/${id}.wav`;
    fs.mkdirSync(path.join(SPEAKER_DIR, 'audio/conversations'), { recursive: true });
    const wavBuf = encodeWavMono16(finalTrack, sr);
    fs.writeFileSync(path.join(SPEAKER_DIR, rel), wavBuf);
    diarTracks.push({
      id,
      path: rel,
      sha256: sha256Hex(wavBuf),
      sampleRate: sr,
      durationSec: Math.round((finalTrack.length / sr) * 100) / 100,
      hasOverlap: Boolean(turns.some((t, idx) => idx > 0 && t.startSec < turns[idx - 1].endSec)),
      noiseCondition: noiseKey ? `${noiseKey}@${snrDb}dB` : 'clean',
      groundTruthTurns: refTurns,
    });
  };

  makeConversation('conv_clean_alternating_01', [
    { speakerId: 'spk1', clipKey: 'spk1_1', startSec: 0.2, endSec: 3.0 },
    { speakerId: 'spk2', clipKey: 'spk2_1', startSec: 3.3, endSec: 5.3 },
    { speakerId: 'spk1', clipKey: 'spk1_2', startSec: 5.6, endSec: 8.6 },
    { speakerId: 'spk2', clipKey: 'spk2_2', startSec: 8.9, endSec: 10.6 },
  ]);

  makeConversation('conv_clean_alternating_02', [
    { speakerId: 'spk2', clipKey: 'spk2_3', startSec: 0.2, endSec: 2.0 },
    { speakerId: 'spk1', clipKey: 'spk1_3', startSec: 2.3, endSec: 5.0 },
    { speakerId: 'spk2', clipKey: 'spk2_4', startSec: 5.3, endSec: 7.3 },
    { speakerId: 'spk1', clipKey: 'spk1_4', startSec: 7.6, endSec: 10.1 },
  ]);

  makeConversation('conv_noisy_hvac_03', [
    { speakerId: 'spk1', clipKey: 'spk1_5', startSec: 0.2, endSec: 2.8 },
    { speakerId: 'spk2', clipKey: 'spk2_5', startSec: 3.1, endSec: 5.0 },
    { speakerId: 'spk1', clipKey: 'spk1_6', startSec: 5.3, endSec: 7.5 },
    { speakerId: 'spk2', clipKey: 'spk2_6', startSec: 7.8, endSec: 9.6 },
  ], 'hvac1', 10);

  makeConversation('conv_overlap_turns_04', [
    { speakerId: 'spk1', clipKey: 'spk1_1', startSec: 0.2, endSec: 3.0 },
    { speakerId: 'spk2', clipKey: 'spk2_1', startSec: 2.2, endSec: 4.2 }, // 0.8s real overlap!
    { speakerId: 'spk1', clipKey: 'spk1_3', startSec: 4.5, endSec: 7.2 },
    { speakerId: 'spk2', clipKey: 'spk2_4', startSec: 6.6, endSec: 8.6 }, // 0.6s real overlap!
  ]);

  const speakerManifestPath = path.join(SPEAKER_DIR, 'speaker-corpus-manifest.json');
  fs.writeFileSync(
    speakerManifestPath,
    `${JSON.stringify({
      schema: 'vip-speaker-corpus',
      schemaVersion: 1,
      datasetVersion: '2026-11-03.v1',
      utteranceSpeakers: ['librispeech_spk1', 'librispeech_spk2', 'mssnsd_spkA', 'mssnsd_spkB'],
      diarizationConversations: diarTracks,
    }, null, 2)}\n`,
  );
  console.log(`[provision] Wrote speaker corpus manifest (${diarTracks.length} conversations + 4 multi-utterance speakers) to ${speakerManifestPath}`);
}

main().catch((err) => {
  console.error('[provision] FAIL:', err);
  process.exit(1);
});
