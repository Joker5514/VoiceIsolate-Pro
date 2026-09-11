'use strict';
/**
 * Tests for upload / audio decode reliability fixes in src/pipeline/media-decode.js:
 *
 *  Fix 1 – decodeAudioData falsy error → proper Error object
 *  Fix 2 – media.src CSP-throw guarded
 *  Fix 3 – HTMLMediaElement error codes translated to actionable text
 *  Fix 4 – numChannels read from media element after metadata (mono detection)
 */

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '../src/pipeline/media-decode.js'), 'utf8');

// ── Fix 1: decodeAudioData falsy error → proper Error ─────────────────────────

describe('decodeAudioData onErr callback wraps falsy error', () => {
  test('source contains instanceof Error guard before rejection', () => {
    expect(SRC).toMatch(
      /err instanceof Error \? err : new Error\(String\(err \|\| 'decodeAudioData failed'\)\)/,
    );
  });

  test('legacy pattern reject(err || ...) is replaced', () => {
    // The old pattern was: reject(err || new Error('decodeAudioData failed'))
    // It should no longer exist verbatim.
    expect(SRC).not.toMatch(/reject\(err \|\| new Error\('decodeAudioData failed'\)\)/);
  });
});

// ── Fix 2: media.src assignment guarded ───────────────────────────────────────

describe('media.src assignment guarded against CSP/security throws', () => {
  test('media.src is inside a try block', () => {
    // Verify try { media.src = url; } catch pattern exists
    expect(SRC).toMatch(/try\s*\{[\s\S]*?media\.src\s*=\s*url[\s\S]*?\}\s*catch/);
  });

  test('catch block throws a VIP-prefixed error', () => {
    expect(SRC).toMatch(/Cannot set media source/);
  });
});

// ── Fix 3: HTMLMediaElement error code translation ────────────────────────────

describe('HTMLMediaElement error codes translated to user-friendly text', () => {
  test('code 1 → load aborted', () => {
    expect(SRC).toContain("code === 1 ? 'load aborted'");
  });

  test('code 2 → network error', () => {
    expect(SRC).toContain("code === 2 ? 'network error'");
  });

  test('code 3 → decode failed', () => {
    expect(SRC).toMatch(/code === 3 \? 'decode failed/);
  });

  test('code 4 → unsupported format or codec', () => {
    expect(SRC).toMatch(/code === 4 \? 'unsupported format or codec'/);
  });

  test('error message uses VIP prefix', () => {
    // Verify the error thrown in _waitForMetadata fail() is prefixed
    expect(SRC).toMatch(/\[VIP\]\[FileIngestion\].*msg/);
  });

  test('numeric code fallback is still included for unknown codes', () => {
    // When code is unknown (not 1-4), codeDesc is null and code is appended
    expect(SRC).toMatch(/code && !codeDesc/);
  });
});

// ── Fix 4: numChannels from media element after metadata ──────────────────────

describe('numChannels is read from the media element, not hardcoded to 2', () => {
  test('numChannels uses mozChannels or audioTracks fallback', () => {
    expect(SRC).toMatch(/mozChannels\s*\|\|\s*media\.audioTracks/);
  });

  test('numChannels is clamped between 1 and 2', () => {
    // Math.min(2, Math.max(1, ...))
    expect(SRC).toMatch(/Math\.min\(\s*2\s*,\s*Math\.max\(\s*1\s*,/);
  });

  test('createScriptProcessor still uses the numChannels variable', () => {
    // Existing test in m4a-decode-fallback.test.js also asserts this — double-check here.
    expect(SRC).toContain('createScriptProcessor(SPN_BLOCK_SIZE, numChannels, numChannels)');
  });

  test('hardcoded const numChannels = 2 is no longer present', () => {
    expect(SRC).not.toMatch(/^\s*const numChannels = 2;/m);
  });
});
