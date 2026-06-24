'use strict';

const fs = require('fs');
const path = require('path');

describe('landing export UI wiring', () => {
  test('index.html exposes three export buttons', () => {
    const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
    expect(html).toContain('id="exportMixBtn"');
    expect(html).toContain('id="exportVoiceBtn"');
    expect(html).toContain('id="exportNoiseBtn"');
  });

  test('landing.js wires ExportEngine and export buttons', () => {
    const js = fs.readFileSync(path.join(__dirname, '../public/landing.js'), 'utf8');
    expect(js).toContain("import { ExportEngine } from '/src/pipeline/ExportEngine.js';");
    expect(js).toContain('wireExportButtons()');
    expect(js).toContain("bind(ui.exportMixBtn, 'exportMix'");
    expect(js).toContain("bind(ui.exportVoiceBtn, 'exportVoice'");
    expect(js).toContain("bind(ui.exportNoiseBtn, 'exportNoise'");
  });
});