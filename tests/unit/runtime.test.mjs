import { describe, it, expect, beforeEach, vi } from 'vitest';

async function loadRuntime(mockEnv = {}) {
  vi.resetModules();
  global.window = global.window || {};
  global.document = global.document || {
    addEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
    getElementById: vi.fn(() => null),
  };
  global.navigator = { userAgent: mockEnv.userAgent || '' };
  global.window.crossOriginIsolated = mockEnv.crossOriginIsolated ?? false;
  global.SharedArrayBuffer = mockEnv.hasSAB ? function () {} : undefined;
  global.AudioContext = mockEnv.hasAudioWorklet
    ? class {
        static get prototype() {
          return { audioWorklet: {} };
        }
      }
    : undefined;
  if (mockEnv.hasAudioWorklet) {
    global.AudioContext.prototype.audioWorklet = {};
  }
  global.OfflineAudioContext = mockEnv.hasOfflineAudioContext
    ? function () {}
    : undefined;

  await import('../../public/app/runtime.js');
  return global.window.VIP_STATE;
}

describe('runtime capability gating', () => {
  beforeEach(() => {
    delete global.window;
    delete global.document;
    delete global.navigator;
    delete global.SharedArrayBuffer;
    delete global.AudioContext;
    delete global.OfflineAudioContext;
  });

  it('selects full-live on isolated web with SAB + AudioWorklet', async () => {
    const state = await loadRuntime({
      crossOriginIsolated: true,
      hasSAB: true,
      hasAudioWorklet: true,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0)',
    });
    expect(state.mode).toBe('full-live');
  });

  it('does not grant full-live parity on Android WebView without isolation', async () => {
    const state = await loadRuntime({
      crossOriginIsolated: false,
      hasSAB: false,
      hasAudioWorklet: true,
      hasOfflineAudioContext: true,
      userAgent: 'Mozilla/5.0 (Linux; Android 13; wv) AppleWebKit',
    });
    expect(state.mode).not.toBe('full-live');
    expect(['offline-only', 'limited-live']).toContain(state.mode);
  });

  it('falls back to offline-only when AudioWorklet missing but OfflineAudioContext present', async () => {
    const state = await loadRuntime({
      crossOriginIsolated: false,
      hasSAB: false,
      hasAudioWorklet: false,
      hasOfflineAudioContext: true,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0)',
    });
    expect(state.mode).toBe('offline-only');
  });

  it('reports unsupported when core audio primitives are missing', async () => {
    const state = await loadRuntime({
      crossOriginIsolated: false,
      hasSAB: false,
      hasAudioWorklet: false,
      hasOfflineAudioContext: false,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0)',
    });
    expect(state.mode).toBe('unsupported');
    expect(state.reasons).toContain('missing-core-audio-primitives');
  });

  it('does not crash when SharedArrayBuffer is absent', async () => {
    await expect(
      loadRuntime({
        crossOriginIsolated: true,
        hasSAB: false,
        hasAudioWorklet: true,
        userAgent: 'Mozilla/5.0 (Windows NT 10.0)',
      })
    ).resolves.toBeDefined();
  });

  it('selects limited-live when AudioWorklet available but not isolated (non-Android)', async () => {
    const state = await loadRuntime({
      crossOriginIsolated: false,
      hasSAB: false,
      hasAudioWorklet: true,
      userAgent: 'Mozilla/5.0 (Macintosh)',
    });
    expect(state.mode).toBe('limited-live');
  });
});
