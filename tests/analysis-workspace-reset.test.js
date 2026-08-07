'use strict';

const fs = require('fs');
const path = require('path');

const appJs = fs.readFileSync(
  path.join(__dirname, '../public/app/app.js'),
  'utf8'
);

const workspaceJs = fs.readFileSync(
  path.join(__dirname, '../public/app/lib/analysis-workspace.js'),
  'utf8'
);

describe('analysis collaboration reset wiring', () => {
  test('handleFile and _clearFile reset collaboration state', () => {
    expect(appJs).toContain('_resetCollaborationState() {');
    // Signature may include options = {} (library open / re-entry).
    expect(appJs).toMatch(
      /async handleFile\(file(?:,\s*options\s*=\s*\{\})?\)\s*\{[\s\S]*?this\._decodeReady\s*=\s*false;[\s\S]*?this\._resetCollaborationState\?\.\(\);/
    );
    expect(appJs).toMatch(
      /_clearFile\(\)\s*\{[\s\S]*?this\._decodeReady\s*=\s*false;[\s\S]*?this\._resetCollaborationState\?\.\(\);/
    );
  });

  test('analysis workspace exposes clearState for upload resets', () => {
    expect(workspaceJs).toContain('function clearState() {');
    expect(workspaceJs).toContain('lastAnalysis = null;');
    expect(workspaceJs).toContain("if (els.root) els.root.dataset.state = 'idle';");
    expect(workspaceJs).toContain('clearState,');
  });
});
