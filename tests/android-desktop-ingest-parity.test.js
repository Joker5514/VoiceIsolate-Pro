'use strict';
/**
 * "All 3 versions in sync" (Randy): the Stems/Engineer experience on Android
 * Chrome, desktop Chrome, and small/constrained phones. All three run the same
 * src/ ingestion code; only the device tier differs. The tier may change the
 * *strategy* (full decode vs streamed windows) to respect memory, but never
 * the measured layout, the accepted/refused verdict, or the decoded PCM length.
 *
 * Before this change a fragmented MP4 was accepted on desktop (full decode)
 * but refused on Android (chunked mode had no sample table), and a video-only
 * MP4 was refused on Android but ran a realtime capture for its full length on
 * desktop.
 */
const fs = require('fs');
const path = require('path');

let preflight;
let budget;
beforeAll(async () => {
  preflight = await import('../src/pipeline/IngestionPreflight.js');
  budget = await import('../src/core/IngestionBudget.js');
});

const FIX = path.join(__dirname, 'fixtures', 'mp4');
function fixture(name) {
  const file = new Blob([fs.readFileSync(path.join(FIX, name))], { type: 'video/mp4' });
  Object.defineProperty(file, 'name', { value: name });
  return file;
}

// Feature-detected signals PerformanceTier reads (no UA sniffing).
const DEVICES = {
  desktop: { deviceMemory: 16, hardwareConcurrency: 12, coarse: false, width: 1440 }, // HIGH
  android: { deviceMemory: 8, hardwareConcurrency: 8, coarse: true, width: 384 }, // S24-class: BALANCED
  constrained: { deviceMemory: 2, hardwareConcurrency: 4, coarse: true, width: 360 }, // CONSTRAINED
};

function asDevice(d) {
  const nav = globalThis.navigator;
  const saved = {
    deviceMemory: Object.getOwnPropertyDescriptor(nav, 'deviceMemory'),
    hardwareConcurrency: Object.getOwnPropertyDescriptor(nav, 'hardwareConcurrency'),
    matchMedia: globalThis.matchMedia,
    innerWidth: globalThis.innerWidth,
  };
  Object.defineProperty(nav, 'deviceMemory', { value: d.deviceMemory, configurable: true });
  Object.defineProperty(nav, 'hardwareConcurrency', { value: d.hardwareConcurrency, configurable: true });
  globalThis.matchMedia = (q) => ({ matches: /coarse/.test(q) ? d.coarse : false });
  globalThis.innerWidth = d.width;
  return () => {
    for (const k of ['deviceMemory', 'hardwareConcurrency']) {
      if (saved[k]) Object.defineProperty(nav, k, saved[k]); else delete nav[k];
    }
    globalThis.matchMedia = saved.matchMedia;
    globalThis.innerWidth = saved.innerWidth;
  };
}

async function planOn(device, name) {
  const restore = asDevice(DEVICES[device]);
  try { return await preflight.preflightIngestion(fixture(name)); } finally { restore(); }
}

test.each(['progressive.mp4', 'frag-moof-base.mp4', 'frag-data-offset.mp4'])(
  '%s: Android, desktop and constrained phones read the same layout from the container',
  async (name) => {
    const plans = {};
    for (const device of Object.keys(DEVICES)) plans[device] = await planOn(device, name);
    expect(plans.desktop.tier).toBe('HIGH');
    expect(plans.android.tier).toBe('BALANCED');
    expect(plans.constrained.tier).toBe('CONSTRAINED');
    for (const plan of Object.values(plans)) {
      expect(plan.frameAuthority).toBe('pcm');
      expect(plan.metadataSource).toBe('mp4-sample-table');
      expect(plan.strategy).not.toBe('refuse');
      expect(plan.channels).toBe(plans.desktop.channels);
      expect(plan.sourceFrames).toBe(plans.desktop.sourceFrames);
      expect(plan.totalFrames).toBe(plans.desktop.totalFrames);
    }
  },
);

test('a video-only MP4 gets the same NO_AUDIO_TRACK refusal on every device', async () => {
  for (const device of Object.keys(DEVICES)) {
    await expect(planOn(device, 'video-only.mp4')).rejects.toMatchObject({ code: 'NO_AUDIO_TRACK' });
  }
});

test('207 MB-class 10-minute stereo video: desktop decodes in full, Android streams windows', () => {
  // Layout as the container reports it for the live file class (600 s, 2 ch, 48 kHz).
  const meta = { duration: 600, channels: 2, sampleRate: 48000, frames: 28_800_000, source: 'mp4-sample-table', complete: true };
  const bytes = 207_249_275;
  const high = budget.resolveIngestionPlan(meta, bytes, budget.ingestionBudget({ deviceMemory: 16 }, 'HIGH'));
  const balanced = budget.resolveIngestionPlan(meta, bytes, budget.ingestionBudget({ deviceMemory: 8 }, 'BALANCED'));
  const constrained = budget.resolveIngestionPlan(meta, bytes, budget.ingestionBudget({ deviceMemory: 2 }, 'CONSTRAINED'));
  expect(high.strategy).toBe('full');
  for (const plan of [balanced, constrained]) {
    expect(plan.strategy).toBe('chunked');
    expect(plan.chunk.viable).toBe(true);
    // A window, not the file, is resident: the peak stays inside the phone budget.
    expect(plan.chunk.peakBytes).toBeLessThanOrEqual(plan.budgetBytes);
  }
  // Same PCM either way: windowing never truncates or downsamples.
  expect(new Set([high.totalFrames, balanced.totalFrames, constrained.totalFrames]).size).toBe(1);
});
