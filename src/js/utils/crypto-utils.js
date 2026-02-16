/**
 * VoiceIsolate Pro v9.0 - Cryptographic Utilities
 *
 * All operations use the Web Crypto API (SubtleCrypto).
 * No custom or third-party cryptography is used.
 *
 * Provides:
 *   - AES-256-GCM symmetric encryption for voiceprint data
 *   - SHA-256 hashing for forensic audit logging
 *   - Structured audit log entry generation
 */

const ALGORITHM = 'AES-GCM';
const KEY_LENGTH = 256; // bits
const IV_LENGTH = 12;   // bytes -- recommended for AES-GCM per NIST SP 800-38D

/**
 * Get the SubtleCrypto instance, throwing a clear error if unavailable.
 * @returns {SubtleCrypto}
 */
function getSubtle() {
  if (typeof crypto === 'undefined' || !crypto.subtle) {
    throw new Error(
      'Web Crypto API (crypto.subtle) is not available. ' +
        'This application must be served over HTTPS or from localhost.',
    );
  }
  return crypto.subtle;
}

// ---------------------------------------------------------------------------
// Key management
// ---------------------------------------------------------------------------

/**
 * Generate a new AES-256-GCM CryptoKey.
 *
 * The key is extractable so it can be exported and stored via `exportKey()`.
 *
 * @returns {Promise<CryptoKey>}
 */
export async function generateKey() {
  const subtle = getSubtle();

  return subtle.generateKey(
    {
      name: ALGORITHM,
      length: KEY_LENGTH,
    },
    true, // extractable
    ['encrypt', 'decrypt'],
  );
}

/**
 * Export a CryptoKey to JSON Web Key (JWK) format for safe storage.
 *
 * @param {CryptoKey} key
 * @returns {Promise<JsonWebKey>}
 */
export async function exportKey(key) {
  const subtle = getSubtle();
  return subtle.exportKey('jwk', key);
}

/**
 * Import a CryptoKey from a previously-exported JWK object.
 *
 * @param {JsonWebKey} jwk
 * @returns {Promise<CryptoKey>}
 */
export async function importKey(jwk) {
  const subtle = getSubtle();

  return subtle.importKey(
    'jwk',
    jwk,
    {
      name: ALGORITHM,
      length: KEY_LENGTH,
    },
    true, // extractable
    ['encrypt', 'decrypt'],
  );
}

// ---------------------------------------------------------------------------
// Encryption / Decryption
// ---------------------------------------------------------------------------

/**
 * Encrypt data with AES-256-GCM.
 *
 * Accepts an ArrayBuffer, TypedArray, or string.  Strings are UTF-8 encoded.
 *
 * @param {ArrayBuffer|TypedArray|string} data
 * @param {CryptoKey} key
 * @returns {Promise<{ iv: Uint8Array, ciphertext: ArrayBuffer }>}
 */
export async function encrypt(data, key) {
  const subtle = getSubtle();

  // Normalise input to ArrayBuffer.
  let plaintext;
  if (typeof data === 'string') {
    plaintext = new TextEncoder().encode(data);
  } else if (ArrayBuffer.isView(data)) {
    plaintext = data;
  } else if (data instanceof ArrayBuffer) {
    plaintext = new Uint8Array(data);
  } else {
    throw new TypeError('encrypt: data must be an ArrayBuffer, TypedArray, or string');
  }

  // Generate a fresh IV for every encryption operation.
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));

  const ciphertext = await subtle.encrypt(
    { name: ALGORITHM, iv },
    key,
    plaintext,
  );

  return { iv, ciphertext };
}

/**
 * Decrypt data that was encrypted with `encrypt()`.
 *
 * @param {{ iv: Uint8Array, ciphertext: ArrayBuffer }} encryptedData
 * @param {CryptoKey} key
 * @returns {Promise<ArrayBuffer>}
 */
export async function decrypt(encryptedData, key) {
  const subtle = getSubtle();

  if (!encryptedData || !encryptedData.iv || !encryptedData.ciphertext) {
    throw new TypeError('decrypt: encryptedData must have { iv, ciphertext }');
  }

  return subtle.decrypt(
    { name: ALGORITHM, iv: encryptedData.iv },
    key,
    encryptedData.ciphertext,
  );
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

/**
 * Compute a SHA-256 hash and return it as a lowercase hexadecimal string.
 *
 * Accepts ArrayBuffer, TypedArray, or string.
 *
 * @param {ArrayBuffer|TypedArray|string} data
 * @returns {Promise<string>} Hex-encoded SHA-256 digest.
 */
export async function hashSHA256(data) {
  const subtle = getSubtle();

  let buffer;
  if (typeof data === 'string') {
    buffer = new TextEncoder().encode(data);
  } else if (ArrayBuffer.isView(data)) {
    buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  } else if (data instanceof ArrayBuffer) {
    buffer = data;
  } else {
    throw new TypeError('hashSHA256: data must be an ArrayBuffer, TypedArray, or string');
  }

  const digest = await subtle.digest('SHA-256', buffer);
  return arrayBufferToHex(digest);
}

// ---------------------------------------------------------------------------
// Audit logging
// ---------------------------------------------------------------------------

/**
 * Generate a structured, tamper-evident audit log entry.
 *
 * Each entry includes:
 *   - Unique ID (UUID v4 via crypto.randomUUID or fallback)
 *   - ISO 8601 timestamp
 *   - Operation description
 *   - SHA-256 hashes of input and output data
 *   - Integrity hash of the entry itself
 *
 * @param {string} operation    Human-readable description of the operation.
 * @param {string} inputHash    SHA-256 hex hash of the input data.
 * @param {string} outputHash   SHA-256 hex hash of the output data.
 * @returns {Promise<{
 *   id: string,
 *   timestamp: string,
 *   operation: string,
 *   inputHash: string,
 *   outputHash: string,
 *   integrityHash: string
 * }>}
 */
export async function generateAuditEntry(operation, inputHash, outputHash) {
  const id = generateUUID();
  const timestamp = new Date().toISOString();

  // Create a deterministic payload string for the integrity hash.
  const payload = JSON.stringify({ id, timestamp, operation, inputHash, outputHash });
  const integrityHash = await hashSHA256(payload);

  return {
    id,
    timestamp,
    operation,
    inputHash,
    outputHash,
    integrityHash,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Convert an ArrayBuffer to a lowercase hex string.
 *
 * @param {ArrayBuffer} buffer
 * @returns {string}
 */
function arrayBufferToHex(buffer) {
  const bytes = new Uint8Array(buffer);
  const hex = new Array(bytes.length);

  for (let i = 0; i < bytes.length; i++) {
    hex[i] = bytes[i].toString(16).padStart(2, '0');
  }

  return hex.join('');
}

/**
 * Generate a UUID v4 using crypto.randomUUID when available,
 * with a manual fallback for older browsers.
 *
 * @returns {string}
 */
function generateUUID() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  // Manual UUID v4 generation using crypto.getRandomValues.
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);

  // Set version (4) and variant (10xx) bits per RFC 4122.
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = arrayBufferToHex(bytes.buffer);
  return (
    hex.substring(0, 8) + '-' +
    hex.substring(8, 12) + '-' +
    hex.substring(12, 16) + '-' +
    hex.substring(16, 20) + '-' +
    hex.substring(20, 32)
  );
}
