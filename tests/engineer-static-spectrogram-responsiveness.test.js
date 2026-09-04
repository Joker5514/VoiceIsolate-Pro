/**
 * Engineer static spectrogram responsiveness guards.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const premiumVisuals = fs.readFileSync(
  path.join(__dirname, '../public/app/premium-visuals.js'),
  'utf8',
);

describe('Engineer static spectrogram responsiveness', () => {
  test('overrides the legacy synchronous helper after visuals.js', () => {
    expect(premiumVisuals).toContain('drawStaticSpectrogramCooperative');
    expect(premiumVisuals).toContain(
      'global.VIP_drawStaticSpectrogram = drawStaticSpectrogramCooperative;',
    );
  });

  test('prefers async STFT and periodically yields during rasterization', () => {
    expect(premiumVisuals).toContain('dsp.forwardSTFTAsync');
    expect(premiumVisuals).toMatch(/await dsp\.forwardSTFTAsync/);
    expect(premiumVisuals).toContain('await yieldVisualWork();');
  });

  test('cancels stale visualization generations', () => {
    expect(premiumVisuals).toContain('staticSpectrogramGeneration');
    expect(premiumVisuals).toMatch(/generation === staticSpectrogramGeneration/);
    expect(premiumVisuals).toMatch(/if \(!isCurrent\(\)\) return false/);
  });

  test('mirrors the completed async frame into the legacy 3D canvas', () => {
    expect(premiumVisuals).toContain("getElementById?.('spectroCanvas')");
    expect(premiumVisuals).toMatch(/mirrorCtx\.drawImage\(canvas/);
  });
});
