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
    expect(appSource).toContain("function downloadWav(audioBuffer, name, ditherMode = 0)");
    expect(appSource).toContain('downloadWav(buf, \'processed-\' + Date.now() + \'.wav\', ditherAmt);');
    expect(appSource).toContain('encodeWav(channels, fullBuf.sampleRate, { ditherAmt });');
  });

  test('Analysis Workspace Export uses the same canonical dither snapshot', () => {
    expect(analysisSource).toContain("import { buildMlProcessingConfig } from '/src/core/ParameterSchema.js';");
    expect(analysisSource).toContain('const ditherAmt = buildMlProcessingConfig(params).export.ditherAmt;');
    expect(analysisSource).toContain('exportAudioBuffer(buf, name, { ditherAmt });');
  });

  test('the shared WAV encoder alone adds quantisation dither', () => {
    expect(exportSource).toContain('const ditherMode = Math.max(0, Math.min(3, Math.round(Number(options.ditherAmt) || 0)));');
    expect(exportSource).toContain('if (ditherMode > 0)');
    const fallbackStart = appSource.indexOf('async _runFallbackPipeline');
    const fallbackEnd = appSource.indexOf('\n  _applyOutputSafetyLimit(', fallbackStart);
    expect(appSource.slice(fallbackStart, fallbackEnd)).not.toContain('applyDither');
  });
});
