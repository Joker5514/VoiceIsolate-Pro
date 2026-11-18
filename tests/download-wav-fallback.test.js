/**
 * @jest-environment jsdom
 *
 * Round 10, item 5: the processed WAV download can be lost (blob URL revoked
 * 4 s after the click while a Save-As or "download multiple files" prompt is
 * still open, after a long render). Keep the URL alive longer and offer a
 * visible "Download WAV" link once the export is ready.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
let triggerBlobDownload;
let offerDownloadLink;

beforeAll(async () => {
  ({ triggerBlobDownload, offerDownloadLink } = await import('../src/pipeline/video-export.js'));
});

beforeEach(() => {
  let n = 0;
  global.URL.createObjectURL = jest.fn(() => `blob:test/${++n}`);
  global.URL.revokeObjectURL = jest.fn();
  document.body.innerHTML = '<p id="procDownloadFallback" hidden><a id="procDownloadFallbackLink" href="#">Download WAV</a></p>';
});

test('the automatic download URL is not revoked while a save prompt may still be open', () => {
  jest.useFakeTimers();
  HTMLAnchorElement.prototype.click = jest.fn();
  triggerBlobDownload(new Blob(['x']), 'a.wav');
  jest.advanceTimersByTime(30000);
  expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  jest.advanceTimersByTime(40000);
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test/1');
  jest.useRealTimers();
});

test('a visible Download WAV link points at the finished export', () => {
  const url = offerDownloadLink(new Blob(['pcm']), 'processed-1.wav');
  const p = document.getElementById('procDownloadFallback');
  const a = document.getElementById('procDownloadFallbackLink');
  expect(p.hidden).toBe(false);
  expect(a.getAttribute('href')).toBe(url);
  expect(a.getAttribute('download')).toBe('processed-1.wav');
  expect(a.textContent).toContain('processed-1.wav');
});

test('a newer export replaces the link and frees the old URL', () => {
  const first = offerDownloadLink(new Blob(['1']), 'processed-1.wav');
  const second = offerDownloadLink(new Blob(['2']), 'processed-2.wav');
  expect(URL.revokeObjectURL).toHaveBeenCalledWith(first);
  expect(document.getElementById('procDownloadFallbackLink').getAttribute('href')).toBe(second);
});

test('offerDownloadLink(null) hides the link (new file loaded)', () => {
  const url = offerDownloadLink(new Blob(['1']), 'processed-1.wav');
  offerDownloadLink(null);
  expect(document.getElementById('procDownloadFallback').hidden).toBe(true);
  expect(URL.revokeObjectURL).toHaveBeenCalledWith(url);
});

test('wiring: Save section has the hidden link; WAV and video exports offer it; a new file clears it', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public/app/index.html'), 'utf8');
  const save = html.slice(html.indexOf('id="section-save"'), html.indexOf('</details>', html.indexOf('id="section-save"')));
  expect(save).toMatch(/<p id="procDownloadFallback"[^>]*\bhidden\b/);
  expect(save).toContain('id="procDownloadFallbackLink"');
  const app = fs.readFileSync(path.join(ROOT, 'public/app/app.js'), 'utf8');
  const dl = app.slice(app.indexOf('async _downloadProcessed()'), app.indexOf('/** @deprecated Use decodeBlobToAudioBuffer'));
  expect(dl).toContain('offerDownloadLink(result.blob, result.filename)');
  expect(dl).toContain('offerDownloadLink(blob, filename)');
  const reset = app.slice(app.indexOf('_resetSessionMetrics() {'), app.indexOf('_computeSessionMetricsState() {'));
  expect(reset).toContain('offerDownloadLink(null)');
});
