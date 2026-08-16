/**
 * Gap-fill: export cancel overlay, landing cancel, lazy Engineer accordions.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const appJs = fs.readFileSync(path.join(ROOT, 'public/app/app.js'), 'utf8');
const landingJs = fs.readFileSync(path.join(ROOT, 'public/landing.js'), 'utf8');
const landingHtml = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const videoExport = fs.readFileSync(path.join(ROOT, 'src/pipeline/video-export.js'), 'utf8');
const engCss = fs.readFileSync(path.join(ROOT, 'public/app/engineer-console.css'), 'utf8');

describe('Gap-fill export + landing cancel + lazy sliders', () => {
  test('Engineer export uses JobController + overlay', () => {
    expect(appJs).toMatch(/async _downloadProcessed/);
    expect(appJs).toMatch(/beginJob\?\.\(['"]Export processed/);
    expect(appJs).toMatch(/showProcessingOverlay/);
    expect(appJs).toMatch(/Export cancelled/);
  });

  test('video-export respects AbortSignal', () => {
    expect(videoExport).toMatch(/opts\.signal|signal\?\.aborted/);
    expect(videoExport).toMatch(/CancellationError/);
  });

  test('Landing has Cancel control and JobController wiring', () => {
    expect(landingHtml).toMatch(/cancelProcessBtn/);
    expect(landingJs).toMatch(/cancelLandingJob|cancelCurrent/);
    expect(landingJs).toMatch(/beginJob/);
    expect(landingJs).toMatch(/from '\/src\/pipeline\/JobController\.js'/);
  });

  test('Engineer lazy accordion defers closed panels', () => {
    expect(appJs).toMatch(/_pendingSlidersByPanel/);
    expect(appJs).toMatch(/_flushPendingSlidersFor|_wireLazySliderPanel/);
    expect(appJs).toMatch(/details && !details\.open/);
  });

  test('Simple view hides more rack chrome', () => {
    expect(engCss).toMatch(/ec-simple #section-eq/);
    expect(engCss).toMatch(/ec-simple #section-dynamics/);
  });
});
