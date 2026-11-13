'use strict';
let decode;
beforeAll(async () => {
  decode = await import('../src/pipeline/media-decode.js');
});

function installFakeDocument({ initialDuration, resolvedDuration = null, seekFails = false } = {}) {
  const listeners = new Map();
  const media = {
    duration: initialDuration,
    readyState: 4,
    preload: '',
    muted: false,
    src: '',
    error: null,
    addEventListener(type, fn) {
      const list = listeners.get(type) || [];
      list.push(fn);
      listeners.set(type, list);
    },
    removeEventListener(type, fn) {
      listeners.set(type, (listeners.get(type) || []).filter((f) => f !== fn));
    },
    load() {},
    removeAttribute() {},
  };
  let currentTime = 0;
  let seeked = false;
  Object.defineProperty(media, 'currentTime', {
    get: () => currentTime,
    set: (value) => {
      currentTime = value;
      seeked = true;
      queueMicrotask(() => {
        if (seekFails) {
          media.error = { code: 4 };
          (listeners.get('error') || []).forEach((fn) => fn());
        } else if (resolvedDuration != null) {
          media.duration = resolvedDuration;
          (listeners.get('durationchange') || []).forEach((fn) => fn());
        }
      });
    },
  });
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: () => media };
  return {
    media,
    wasSeeked: () => seeked,
    restore: () => {
      if (previousDocument === undefined) delete globalThis.document;
      else globalThis.document = previousDocument;
    },
  };
}

test('a live WebM reporting Infinity resolves via an end-seek', async () => {
  const fake = installFakeDocument({ initialDuration: Infinity, resolvedDuration: 12.001 });
  try {
    const blob = new Blob([new Uint8Array(64)], { type: 'video/webm' });
    Object.defineProperty(blob, 'name', { value: 'webm_live_named.mp4' });
    await expect(decode.probeMediaMetadata(blob, null, 5000)).resolves.toMatchObject({
      duration: 12.001,
      source: 'media-metadata',
    });
    expect(fake.wasSeeked()).toBe(true);
  } finally {
    fake.restore();
  }
});

test('a finite media duration is returned without seeking', async () => {
  const fake = installFakeDocument({ initialDuration: 5 });
  try {
    const blob = new Blob([new Uint8Array(64)], { type: 'video/mp4' });
    Object.defineProperty(blob, 'name', { value: 'clip.mp4' });
    await expect(decode.probeMediaMetadata(blob, null, 5000)).resolves.toMatchObject({
      duration: 5,
      source: 'media-metadata',
    });
    expect(fake.wasSeeked()).toBe(false);
  } finally {
    fake.restore();
  }
});

test('an Infinity duration that cannot be seeked stays unknown', async () => {
  const fake = installFakeDocument({ initialDuration: Infinity, seekFails: true });
  try {
    const blob = new Blob([new Uint8Array(64)], { type: 'video/webm' });
    Object.defineProperty(blob, 'name', { value: 'webm_live_named.mp4' });
    await expect(decode.probeMediaMetadata(blob, null, 5000)).resolves.toMatchObject({
      duration: null,
      source: 'media-metadata',
    });
  } finally {
    fake.restore();
  }
});

test('no document means no media probe', async () => {
  const blob = new Blob([new Uint8Array(64)], { type: 'video/mp4' });
  await expect(decode.probeMediaMetadata(blob, null, 5000)).resolves.toMatchObject({
    duration: null,
    source: 'media-metadata',
  });
});
