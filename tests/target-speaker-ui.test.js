/**
 * TargetSpeakerUI structure guards (shared Landing + Engineer module).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ui = fs.readFileSync(
  path.join(__dirname, '../src/presentation/TargetSpeakerUI.js'),
  'utf8',
);

describe('TargetSpeakerUI UX', () => {
  test('exports mountTargetSpeakerUI', () => {
    expect(ui).toMatch(/export function mountTargetSpeakerUI/);
  });

  test('includes step-by-step how-to copy', () => {
    expect(ui).toMatch(/Focus on one voice/);
    expect(ui).toMatch(/How to enroll a target voice|vip-ts-steps/);
    expect(ui).toMatch(/Load & prepare audio/);
    expect(ui).toMatch(/Mark a clean speech region/);
    expect(ui).toMatch(/Enroll/);
    expect(ui).toMatch(/Isolate target/);
  });

  test('has tips disclosure and quick-fill helpers', () => {
    expect(ui).toMatch(/Tips for best results/);
    expect(ui).toMatch(/First 2 s/);
    expect(ui).toMatch(/Around playhead/);
    expect(ui).toMatch(/getPlayheadSec|getDurationSec/);
  });

  test('injects self-contained styles for all surfaces', () => {
    expect(ui).toMatch(/vip-target-speaker-styles/);
    expect(ui).toMatch(/ensureStyles/);
  });

  test('Landing mounts shared module', () => {
    const landing = fs.readFileSync(path.join(__dirname, '../public/landing.js'), 'utf8');
    const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
    expect(landing).toMatch(/ensureTargetSpeakerUi/);
    expect(landing).toMatch(/TargetSpeakerUI\.js/);
    expect(html).toMatch(/targetSpeakerLandingPanel/);
    expect(html).toMatch(/id="targetSpeakerPanel"/);
  });

  test('Engineer section uses friendly summary', () => {
    const eng = fs.readFileSync(path.join(__dirname, '../public/app/index.html'), 'utf8');
    expect(eng).toMatch(/Focus on one voice \(target enrollment\)/);
    expect(eng).toMatch(/id="targetSpeakerPanel"/);
  });
});
