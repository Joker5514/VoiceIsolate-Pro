/**
 * Static wiring contract for processed video download (landing + engineer).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const landingJs = fs.readFileSync(path.join(ROOT, 'public/landing.js'), 'utf8');
const landingHtml = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(ROOT, 'public/app/app.js'), 'utf8');
const videoExport = fs.readFileSync(path.join(ROOT, 'src/pipeline/video-export.js'), 'utf8');
const mediaDecode = fs.readFileSync(path.join(ROOT, 'src/pipeline/media-decode.js'), 'utf8');

describe('Video export module', () => {
  test('exports remux helpers without ffmpeg/CDN deps', () => {
    expect(videoExport).toContain('export async function exportVideoWithProcessedAudio');
    expect(videoExport).toContain('MediaRecorder');
    expect(videoExport).toContain('captureStream');
    expect(videoExport).not.toMatch(/cdn\.|unpkg|jsdelivr/i);
  });
});

describe('Media decode video fallback', () => {
  test('uses muted capture + silentGain (autoplay-safe; SPN still hears graph)', () => {
    // muted=true unblocks play() under autoplay policy; ScriptProcessor still
    // receives PCM from createMediaElementSource. silentGain=0 avoids speaker bleed.
    expect(mediaDecode).toMatch(/media\.muted\s*=\s*true/);
    expect(mediaDecode).toMatch(/media\.volume\s*=\s*0/);
    expect(mediaDecode).toContain('silentGain');
  });
});

describe('Landing — processed download', () => {
  test('has a download control in the shell', () => {
    expect(landingHtml).toContain('id="downloadBtn"');
    expect(landingHtml).toContain('id="exportRow"');
  });

  test('wires video remux on download for video sources', () => {
    expect(landingJs).toContain('exportVideoWithProcessedAudio');
    expect(landingJs).toContain('onDownloadProcessed');
    expect(landingJs).toContain('isVideoSource');
    expect(landingJs).toContain('sourceFile');
    expect(landingJs).toMatch(/Download Processed Video/);
  });
});

describe('Engineer — processed download', () => {
  test('save processed remuxes video when source is video', () => {
    expect(appJs).toContain('_downloadProcessed');
    expect(appJs).toContain('exportVideoWithProcessedAudio');
    expect(appJs).toContain('isVideoSource');
    expect(appJs).toContain('_sourceFile');
    expect(appJs).toContain('Save Processed Video');
  });

  test('always assigns a fresh object URL for video preview', () => {
    expect(appJs).toContain('_videoObjectUrl');
    expect(appJs).toContain('_clearVideoElement');
    expect(appJs).toMatch(/this\.dom\.videoPlayer\.src\s*=\s*url/);
  });
});
