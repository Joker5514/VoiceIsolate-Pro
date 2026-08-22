'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function read(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

describe('served documentation reflects the current production architecture', () => {
  const docs = [
    'public/docs/TECHNICAL_GUIDE.md',
    'public/docs/claude-guide.html',
    'public/blueprint/index.html',
    'docs/guides/MODEL_DELIVERY.md',
  ];

  test.each(docs)('%s does not contain deleted or stale runtime claims', (relPath) => {
    const src = read(relPath);
    const banned = [
      /Grant microphone permission/i,
      /POST\s+\/api\/process/i,
      /api\/nim/i,
      /pipeline-orchestrator/i,
      /vip-slider-patch/i,
      /public\/app\/auth\.js/i,
      /52 sliders?/i,
      /pnpm\s*9\.0\.0/i,
      /pnpm@10\.0\.0/i,
      /Cloudflare R2/i,
      /HuggingFace Hub/i,
      /startMicRecording/i,
      /mic-capture/i,
    ];

    for (const pattern of banned) {
      expect(src).not.toMatch(pattern);
    }
  });

  test('served technical guide names the active runtime files', () => {
    const guide = read('public/docs/TECHNICAL_GUIDE.md');
    expect(guide).toMatch(/public\/src/);
    expect(guide).toMatch(/GateProcessor\.js/);
    expect(guide).toMatch(/DeEsserProcessor\.js/);
    expect(guide).toMatch(/67 sliders/);
  });

  test('model delivery guide documents same-origin model routes only', () => {
    const guide = read('docs/guides/MODEL_DELIVERY.md');
    expect(guide).toMatch(/same-origin \/app\/models\/\*\.onnx/);
    expect(guide).toMatch(/Vercel Blob/);
    expect(guide).toMatch(/There are no browser-facing fallback providers/);
  });
});
