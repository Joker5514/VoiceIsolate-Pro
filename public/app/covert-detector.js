// public/app/covert-detector.js  — run as new Worker('./covert-detector.js')
// Covert / Off-Screen Speaker Detection for VoiceIsolate Pro
// Signals: Whisper fingerprint + diarization clustering + MediaPipe lip-sync
// Emits COVERT_SPEAKER_DETECTED to main thread via postMessage.

importScripts('https://cdn.jsdelivr.net/npm/onnxruntime-web/dist/ort.min.js');

const State = {
  registeredEmbeddings: [],
  clusterBuffer:        [],
  ecapaSession:         null,
  vadSession:           null,
  sampleRate:           16000,
  fftSize:              2048,
  halfN:                1025,
  COVERT_CLUSTER_SIM:   0.65,
  WHISPER_TURBULENCE:   0.40,
  WHISPER_F0_MAX_dB:    -45,
  MIN_COVERT_FRAMES:    3,
  consecutiveCovert:    0,
  lipMotionActive:      false,
};

async function loadModels(modelBasePath) {
  const opts = {
    executionProviders: ['webgpu', 'wasm'],
    graphOptimizationLevel: 'all'
  };
  try {
    State.ecapaSession = await ort.InferenceSession.create(
      `${modelBasePath}/ecapa-tdnn.onnx`, opts
    );
  } catch (e) { console.warn('[CovertDetector] ECAPA load failed:', e.message); }
  try {
    State.vadSession = await ort.InferenceSession.create(
      `${modelBasePath}/silero-vad.onnx`, opts
    );
  } catch (e) { console.warn('[CovertDetector] VAD load failed:', e.message); }
  self.postMessage({ type: 'modelsReady' });
}

function spectralFlatness(mag, binLo, binHi) {
  let logSum = 0, linSum = 0;
  const count = binHi - binLo;
  for (let i = binLo; i < binHi; i++) {
    const m = Math.max(mag[i], 1e-12);
    logSum += Math.log(m);
    linSum += m;
  }
  return Math.exp(logSum / count) / (linSum / count + 1e-12);
}

function f0PeakDB(mag, sampleRate, fftSize) {
  const binLo = Math.floor(80   * fftSize / sampleRate);
  const binHi = Math.ceil (400  * fftSize / sampleRate);
  let peak = 0;
  for (let i = binLo; i < binHi; i++) {
    if (mag[i] > peak) peak = mag[i];
  }
  return 20 * Math.log10(peak + 1e-12);
}

function harmonicScore(mag, f0Bin) {
  if (f0Bin < 2) return 0;
  let score = 0;
  const harmonics = [1, 2, 3, 4];
  for (const h of harmonics) {
    const bin = Math.round(f0Bin * h);
    if (bin < mag.length) score += mag[bin];
  }
  return score / harmonics.length;
}

function detectWhisper(mag, sampleRate, fftSize) {
  const speechLo = Math.floor(300  * fftSize / sampleRate);
  const speechHi = Math.ceil (3400 * fftSize / sampleRate);
  const flatness  = spectralFlatness(mag, speechLo, speechHi);
  const f0dB      = f0PeakDB(mag, sampleRate, fftSize);
  const f0Bin     = Math.floor(150  * fftSize / sampleRate);
  const hScore    = harmonicScore(mag, f0Bin);

  const isWhisper = (
    flatness > State.WHISPER_TURBULENCE &&
    f0dB     < State.WHISPER_F0_MAX_dB  &&
    hScore   < 0.005
  );
  const confidence = Math.min(1, flatness * 1.5) * (f0dB < -50 ? 1.2 : 0.8);
  return { isWhisper, confidence: Math.min(1, confidence), flatness, f0dB };
}

async function getEmbedding(mag) {
  if (!State.ecapaSession) return null;
  try {
    const tensor = new ort.Tensor('float32', mag.slice(), [1, mag.length]);
    const result = await State.ecapaSession.run({ input: tensor });
    return new Float32Array(result.output?.data ?? []);
  } catch (e) {
    console.warn('[CovertDetector] ECAPA error:', e.message);
    return null;
  }
}

function cosineSimilarity(a, b) {
  const len = Math.min(a.length, b.length);
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i]; na += a[i] ** 2; nb += b[i] ** 2;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-10);
}

function isRegisteredSpeaker(embedding) {
  if (!embedding || State.registeredEmbeddings.length === 0) return false;
  for (const reg of State.registeredEmbeddings) {
    const sim = cosineSimilarity(embedding, reg.embedding);
    if (sim >= State.COVERT_CLUSTER_SIM) return true;
  }
  return false;
}

function clusterIdForEmbedding(embedding) {
  let bestId  = 'UNREGISTERED_0';
  let bestSim = -1;
  for (const reg of State.registeredEmbeddings) {
    const sim = cosineSimilarity(embedding, reg.embedding);
    if (sim > bestSim) { bestSim = sim; bestId = reg.id; }
  }
  if (bestSim < State.COVERT_CLUSTER_SIM) {
    const newId = `UNREGISTERED_${State.registeredEmbeddings.length}`;
    State.clusterBuffer.push({ embedding, clusterId: newId });
    if (State.clusterBuffer.length > 200) State.clusterBuffer.shift();
    return newId;
  }
  return bestId;
}

function estimateDirection(tdoaSamples, sampleRate, micSpacingMeters = 0.15) {
  const c = 343;
  const tau = tdoaSamples / sampleRate;
  const sinTheta = (c * tau) / micSpacingMeters;
  const theta = Math.asin(Math.max(-1, Math.min(1, sinTheta)));
  return Math.round(theta * (180 / Math.PI));
}

async function processFrame({ mag, phase, timestamp, audioSnippetBase64 }) {
  const { sampleRate, fftSize } = State;
  const magArr = new Float32Array(mag);

  const whisper      = detectWhisper(magArr, sampleRate, fftSize);
  const embedding    = await getEmbedding(magArr);
  const knownSpeaker = embedding ? isRegisteredSpeaker(embedding) : true;
  const lipMotionContradicts = State.lipMotionActive;

  let rms = 0;
  for (let i = 0; i < magArr.length; i++) rms += magArr[i] ** 2;
  rms = Math.sqrt(rms / magArr.length);
  const rmsDB = 20 * Math.log10(rms + 1e-12);

  const isCovertCandidate = (
    (!knownSpeaker || whisper.isWhisper) &&
    !lipMotionContradicts &&
    rmsDB > -65
  );

  if (isCovertCandidate) {
    State.consecutiveCovert++;
  } else {
    State.consecutiveCovert = 0;
  }

  if (State.consecutiveCovert >= State.MIN_COVERT_FRAMES) {
    State.consecutiveCovert = 0;
    const event = {
      type:               'COVERT_SPEAKER_DETECTED',
      timestamp,
      confidence:         whisper.confidence,
      estimatedDirection: null,
      audioSnippetBase64: audioSnippetBase64 ?? null,
      whisperedText:      null,
      speakerClusterId:   embedding ? clusterIdForEmbedding(embedding) : 'UNKNOWN',
      diagnostics: {
        spectralFlatness: whisper.flatness.toFixed(3),
        f0dB:             whisper.f0dB.toFixed(1),
        rmsDB:            rmsDB.toFixed(1),
        knownSpeaker,
        lipMotionActive:  State.lipMotionActive
      }
    };
    self.postMessage(event);
    if (audioSnippetBase64) {
      self.postMessage({
        type:    'REQUEST_WHISPER_STT',
        payload: { audioSnippetBase64, timestamp }
      });
    }
  }
}

self.onmessage = async ({ data }) => {
  switch (data.type) {
    case 'init':
      State.sampleRate = data.payload.sampleRate ?? 16000;
      State.fftSize    = data.payload.fftSize    ?? 2048;
      State.halfN      = State.fftSize / 2 + 1;
      await loadModels(data.payload.modelBasePath ?? '/app/models');
      break;
    case 'registerSpeaker':
      State.registeredEmbeddings.push({
        id:        data.payload.id,
        embedding: new Float32Array(data.payload.embedding)
      });
      break;
    case 'unregisterSpeaker':
      State.registeredEmbeddings = State.registeredEmbeddings.filter(
        r => r.id !== data.payload.id
      );
      break;
    case 'frame':
      await processFrame(data.payload);
      break;
    case 'lipMotion':
      State.lipMotionActive = !!data.payload.active;
      break;
    case 'tdoa':
      if (data.payload?.samples != null) {
        const deg = estimateDirection(
          data.payload.samples,
          State.sampleRate,
          data.payload.micSpacingMeters ?? 0.15
        );
        self.postMessage({ type: 'DIRECTION_ESTIMATE', degrees: deg });
      }
      break;
    case 'reset':
      State.consecutiveCovert    = 0;
      State.clusterBuffer.length = 0;
      break;
  }
};

self.addEventListener('error', err => {
  self.postMessage({ type: 'error', payload: { message: err.message } });
});
