/**
 * Landing page regressions — video preview + realtime processing spinner.
 *
 * These are static-source assertions (same style as play-button-wiring.test.js)
 * because landing.js is an ES module that boots a Worker + AudioContext, which
 * is exercised end-to-end by scripts/landing-smoke.cjs. Here we lock the wiring
 * contract so the two features cannot silently regress.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const js = fs.readFileSync(path.join(ROOT, 'public/landing.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public/landing.css'), 'utf8');

describe('Landing page — video preview plays in sync with processed audio', () => {
  test('index.html has a muted <video> element inside its card', () => {
    expect(html).toMatch(/<video[^>]*id="videoPlayer"/);
    expect(html).toMatch(/id="videoPlayer"[^>]*\bmuted\b/);
    expect(html).toContain('id="videoCard"');
  });

  test('video source is a local object URL (100% local — never uploaded)', () => {
    expect(js).toContain('URL.createObjectURL(file)');
    expect(js).toContain('URL.revokeObjectURL'); // released to avoid leaks
  });

  test('the video stays muted — sound always comes from the Web Audio mixer', () => {
    // muted enforced in markup AND in JS (alias-agnostic: `v.muted` or `ui.videoPlayer.muted`).
    expect(html).toMatch(/id="videoPlayer"[^>]*\bmuted\b/);
    expect(js).toMatch(/\.muted\s*=\s*true/);
  });

  test('the mixer is the single clock; the muted video only follows it', () => {
    expect(js).toContain('function syncVideo()');
    expect(js).toContain('mixer.isPlaying()');
    // Muted autoplay can still be blocked; the promise must be guarded.
    expect(js).toMatch(/v\.play\(\)\.catch/);
    // Transport + a periodic tick both reconcile the picture.
    expect(js).toMatch(/await mixer\.play\(\);\s*syncVideo\(\)/);
  });

  test('no microphone access anywhere on the landing page (CLAUDE.md §1.1)', () => {
    expect(html).not.toMatch(/getUserMedia/);
    expect(js).not.toMatch(/getUserMedia/);
  });
});

describe('Landing page — realtime processing spinner', () => {
  test('index.html exposes the spinner ring + live readouts', () => {
    for (const id of ['procSpinner', 'procRingFill', 'procPct', 'procStage', 'procProgressbar']) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).toMatch(/role="progressbar"/);
  });

  test('the old thin <progress> bar is fully removed', () => {
    expect(html).not.toContain('inferenceProgress');
    expect(js).not.toContain('ui.progress');
  });

  test('inference progress drives a determinate ring from the worker percent', () => {
    expect(js).toContain('function setProgress(');
    expect(js).toContain("case 'progress'");
    expect(js).toContain('setProgress(msg.percent');
    expect(js).toContain('strokeDashoffset'); // ring fills via dashoffset
  });

  test('decode + resample show an indeterminate spinner', () => {
    expect(js).toContain("showSpinner('Decoding…'");
    expect(js).toContain("showSpinner('Resampling to 48 kHz…'");
    expect(js).toContain('indeterminate: true');
  });

  test('spinner is dismissed on stems, error, and worker failure', () => {
    expect(js).toContain('hideSpinner()');
    // every terminal path clears it
    const hideCount = (js.match(/hideSpinner\(\)/g) || []).length;
    expect(hideCount).toBeGreaterThanOrEqual(4);
  });

  test('CSS defines the spinner + video styles', () => {
    expect(css).toContain('.proc-ring-fill');
    expect(css).toContain('proc-spin'); // indeterminate keyframes
    expect(css).toContain('.video-player');
  });
});
