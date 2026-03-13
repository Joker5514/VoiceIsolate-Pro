// src/worker-pool.js — Web Worker: ONNX inference (Demucs v4 + ECAPA-TDNN)
// Runs in parallel threads; never blocks the UI or AudioWorklet

import * as ort from 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.17.3/dist/ort.esm.min.js';

let session_demucs  = null;
let session_ecapa   = null;
let enrolledPrint   = null;  // Float32Array: enrolled voiceprint embedding
let aesKey          = null;
let paramBuf        = null;
let workerId        = -1;

// ── AES-256-GCM key derivation ─────────────────────────────────────────────
async function generateKey() {
  return crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
}

async function encryptEmbedding(key, embedding) {
  const iv  = crypto.getRandomValues(new Uint8Array(12));
  const enc = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    embedding.buffer
  );
  return { iv, ciphertext: new Uint8Array(enc) };
}

async function decryptEmbedding(key, iv, ciphertext) {
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    ciphertext
  );
  return new Float32Array(plain);
}

// ── DOD 5220.22-M compliant secure wipe ────────────────────────────────────
function secureWipe(arrayBuffer) {
  const v = new Uint8Array(arrayBuffer);
  v.fill(0x00);                          // Pass 1: zeros
  v.fill(0xFF);                          // Pass 2: ones
  crypto.getRandomValues(v);             // Pass 3: cryptographic random
}

// ── Cosine similarity: S = (V_target · V_input) / (|V_target| * |V_input|) ─
function cosineSimilarity(a, b) {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot  += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB) + 1e-12);
}

// ── IndexedDB helpers for encrypted voiceprint storage ─────────────────────
function openDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open('VoiceIsolatePro', 1);
    req.onupgradeneeded = (e) => e.target.result.createObjectStore('voiceprints');
    req.onsuccess = (e) => res(e.target.result);
    req.onerror   = (e) => rej(e.target.error);
  });
}

async function saveVoiceprint(iv, ciphertext) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx  = db.transaction('voiceprints', 'readwrite');
    const store = tx.objectStore('voiceprints');
    store.put({ iv, ciphertext }, 'enrolled');
    tx.oncomplete = res;
    tx.onerror    = (e) => rej(e.target.error);
  });
}

async function loadVoiceprint() {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx    = db.transaction('voiceprints', 'readonly');
    const store = tx.objectStore('voiceprints');
    const req   = store.get('enrolled');
    req.onsuccess = (e) => res(e.target.result);
    req.onerror   = (e) => rej(e.target.error);
  });
}

// ── Message handler ───────────────────────────────────────────────────────
self.onmessage = async ({ data }) => {
  switch (data.type) {

    case 'INIT': {
      workerId = data.workerId;
      paramBuf = new Float32Array(data.paramSab);
      aesKey   = await generateKey();

      console.log(`[Worker ${workerId}] Loading ONNX models with WebGPU EP...`);
      try {
        session_demucs = await ort.InferenceSession.create('/models/demucs_v4_int8.onnx', {
          executionProviders: ['webgpu', 'wasm'],
          graphOptimizationLevel: 'all',
        });
        session_ecapa  = await ort.InferenceSession.create('/models/ecapa_tdnn_int8.onnx', {
          executionProviders: ['webgpu', 'wasm'],
          graphOptimizationLevel: 'all',
        });
        console.log(`[Worker ${workerId}] Models loaded.`);

        // Try to restore encrypted voiceprint from IndexedDB
        const stored = await loadVoiceprint();
        if (stored) {
          enrolledPrint = await decryptEmbedding(aesKey, stored.iv, stored.ciphertext);
          console.log(`[Worker ${workerId}] Restored voiceprint from IndexedDB.`);
        }
      } catch (err) {
        console.warn(`[Worker ${workerId}] ONNX load failed (models not present yet):`, err.message);
      }
      break;
    }

    case 'INFER_ECAPA': {
      if (!session_ecapa || !data.frame) break;
      try {
        const inputArray = new Float32Array(data.frame);
        const tensor = new ort.Tensor('float32', inputArray, [1, 1, inputArray.length]);
        const result  = await session_ecapa.run({ input: tensor });
        const embedding = new Float32Array(result.output.data);

        if (enrolledPrint) {
          const score = cosineSimilarity(enrolledPrint, embedding);
          self.postMessage({ type: 'SIMILARITY', score });
        }

        // Secure wipe of inference buffers
        secureWipe(inputArray.buffer);
      } catch (_) { /* model not loaded or input shape mismatch — skip frame */ }
      break;
    }

    case 'ENROLL_VOICEPRINT': {
      // In production: run ECAPA on a freshly recorded reference clip
      // Here we stub with a random 192-dim embedding (ECAPA-TDNN output size)
      const stub = new Float32Array(192);
      crypto.getRandomValues(new Uint8Array(stub.buffer));
      enrolledPrint = stub;

      const { iv, ciphertext } = await encryptEmbedding(aesKey, stub);
      await saveVoiceprint(iv, ciphertext);

      secureWipe(stub.buffer);
      self.postMessage({ type: 'ENROLLED' });
      break;
    }

    case 'CLEAR_VOICEPRINT': {
      if (enrolledPrint) secureWipe(enrolledPrint.buffer);
      enrolledPrint = null;
      const db = await openDB();
      db.transaction('voiceprints', 'readwrite').objectStore('voiceprints').delete('enrolled');
      break;
    }
  }
};
