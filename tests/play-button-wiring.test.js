const fs = require('fs');
const path = require('path');

describe('play button and controls diagnostics wiring', () => {
  const appJsPath = path.join(__dirname, '../public/app/app.js');
  const indexHtmlPath = path.join(__dirname, '../public/app/index.html');
  const controlsTestPath = path.join(__dirname, 'controls-test.js');

  test('bindEvents wires tpPlay to togglePlayback()', () => {
    const appJs = fs.readFileSync(appJsPath, 'utf8');
    expect(appJs).toContain("bind('playBtn', this.dom.tpPlay, 'click', () => { this.togglePlayback(); });");
  });

  test('onAudioLoaded enables play button alias if present', () => {
    const appJs = fs.readFileSync(appJsPath, 'utf8');
    expect(appJs).toContain('if (this.dom.playBtn) this.dom.playBtn.disabled = false;');
  });

  test('index.html includes clear file control', () => {
    const html = fs.readFileSync(indexHtmlPath, 'utf8');
    expect(html).toContain('id="clearFile"');
  });

  test('controls-test.js exports runControlsDiagnostic entrypoint', () => {
    const controlsJs = fs.readFileSync(controlsTestPath, 'utf8');
    expect(controlsJs).toContain('window.runControlsDiagnostic = runControlsDiagnostic;');
    expect(controlsJs).toContain('window.__vipControlsDiagnosticResult = summary;');
  });
});
