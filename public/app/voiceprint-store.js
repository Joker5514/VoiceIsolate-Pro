// public/app/voiceprint-store.js
// VoiceIsolate Pro — Voiceprint Store
// Stores 192-dim ECAPA-TDNN embeddings in IndexedDB (AES-GCM encrypted).
// Provides EMA adaptation after confirmed sessions.
// 100% local. No network calls.

const DB_NAME    = 'VoiceIsolatePro';
const DB_VERSION = 2;
const STORE_NAME = 'voiceprints';
const EMA_ALPHA  = 0.05; // conservative drift adaptation rate

// ─── AES-GCM key derived from a device-bound secret ───────────────────────
async function getDerivedKey() {
  const raw = new TextEncoder().encode(
    (self.location?.origin ?? 'local') + navigator.userAgent
  );
  const keyMaterial = await crypto.subtle.importKey(
    'raw', await crypto.subtle.digest('SHA-256', raw),
    { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']
  );
  return keyMaterial;
}

async function encryptEmbedding(float32) {
  const key  = await getDerivedKey();
  const iv   = crypto.getRandomValues(new Uint8Array(12));
  const ct   = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, float32.buffer
  );
  return {
    iv: btoa(String.fromCharCode(...iv)),
    ct: btoa(String.fromCharCode(...new Uint8Array(ct)))
  };
}

async function decryptEmbedding(blob) {
  const key = await getDerivedKey();
  const iv  = Uint8Array.from(atob(blob.iv), c => c.charCodeAt(0));
  const ct  = Uint8Array.from(atob(blob.ct), c => c.charCodeAt(0));
  const pt  = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return new Float32Array(pt);
}

// ─── IndexedDB helpers ─────────────────────────────────────────────────────
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

export async function saveVoiceprint(id, embedding, meta = {}) {
  const db      = await openDB();
  const payload = await encryptEmbedding(embedding);
  return new Promise((resolve, reject) => {
    const tx    = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.put({ id, ...payload, meta, updatedAt: Date.now() });
    tx.oncomplete = resolve;
    tx.onerror    = e => reject(e.target.error);
  });
}

export async function loadVoiceprint(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx    = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req   = store.get(id);
    req.onsuccess = async e => {
      if (!e.target.result) return resolve(null);
      try {
        resolve(await decryptEmbedding(e.target.result));
      } catch (err) {
        reject(err);
      }
    };
    req.onerror = e => reject(e.target.error);
  });
}

export async function deleteVoiceprint(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx    = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.delete(id);
    tx.oncomplete = resolve;
    tx.onerror    = e => reject(e.target.error);
  });
}

export async function listVoiceprints() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx    = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req   = store.getAll();
    req.onsuccess = e => resolve(e.target.result.map(r => ({
      id: r.id, meta: r.meta, updatedAt: r.updatedAt
    })));
    req.onerror = e => reject(e.target.error);
  });
}

// ─── EMA Adaptation ───────────────────────────────────────────────────────
export async function adaptVoiceprint(id, newEmbedding, alpha = EMA_ALPHA) {
  const stored = await loadVoiceprint(id);
  if (!stored) return saveVoiceprint(id, newEmbedding);
  if (stored.length !== newEmbedding.length) {
    console.warn('[VoiceprintStore] Dimension mismatch, overwriting');
    return saveVoiceprint(id, newEmbedding);
  }
  const adapted = new Float32Array(stored.length);
  for (let i = 0; i < stored.length; i++) {
    adapted[i] = (1 - alpha) * stored[i] + alpha * newEmbedding[i];
  }
  let norm = 0;
  for (let i = 0; i < adapted.length; i++) norm += adapted[i] ** 2;
  norm = Math.sqrt(norm) + 1e-10;
  for (let i = 0; i < adapted.length; i++) adapted[i] /= norm;
  return saveVoiceprint(id, adapted);
}

// ─── Cosine Similarity (reusable utility) ─────────────────────────────────
export function cosineSimilarity(a, b) {
  const len = Math.min(a.length, b.length);
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na  += a[i] * a[i];
    nb  += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-10);
}
