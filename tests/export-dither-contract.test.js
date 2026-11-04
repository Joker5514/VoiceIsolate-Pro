/** Both processed WAV export surfaces use the canonical encoder-only dither snapshot. */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const appSource = fs.readFileSync(path.join(ROOT, 'public/app/app.js'), 'utf8');
const analysisSource = fs.readFileSync(
  path.join(ROOT, 'public/app/lib/analysis-workspace.js'),
  'utf8',
);
const exportSource = fs.readFileSync(path.join(ROOT, 'src/pipeline/ExportManager.js'), 'utf8');

describe('processed WAV dither contract', () => {
  test('Save Processed snapshots dither at the 16-bit encoder boundary', () => {
    // VIP-020: downloadWav gained an optional 5th ditherSeed (forensic
    // deterministic dither); the signature stays backward compatible and
    // Save Processed still routes ditherAmt through it.
    expect(appSource).toContain("async function downloadWav(audioBuffer, name, ditherMode = 0, signal = null, ditherSeed = undefined)");
    expect(appSource).toMatch(/const wavName = 'processed-' \+ Date\.now\(\) \+ '\.wav';[\s\S]{0,200}await downloadWav\(buf, wavName, ditherAmt, signal, ditherSeed\);/);
    expect(appSource).toContain('encodeWav(channels, mixBuf.sampleRate, { ditherAmt, ditherSeed });');
  });

  test('Analysis Workspace Export uses the same canonical dither snapshot', () => {
    expect(analysisSource).toContain("import { buildMlProcessingConfig } from '/src/core/ParameterSchema.js';");
    expect(analysisSource).toContain('const ditherAmt = buildMlProcessingConfig(params).export.ditherAmt;');
    // VIP-020: workspace export passes the same ditherAmt plus the optional
    // forensic seed; ditherAmt must still flow to the shared encoder.
    expect(analysisSource).toContain('exportAudioBuffer(buf, name, { ditherAmt, ditherSeed });');
  });

  test('the shared WAV encoder alone adds quantisation dither', () => {
    expect(exportSource).toContain('const ditherMode = Math.max(0, Math.min(3, Math.round(Number(options.ditherAmt) || 0)));');
    expect(exportSource).toContain('if (ditherMode > 0)');
    const fallbackStart = appSource.indexOf('async _runFallbackPipeline');
    const fallbackEnd = appSource.indexOf('\n  _applyOutputSafetyLimit(', fallbackStart);
    expect(appSource.slice(fallbackStart, fallbackEnd)).not.toContain('applyDither');
  });
});
