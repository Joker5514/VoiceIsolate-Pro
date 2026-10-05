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

  test('a file change or clear during the async downmix invalidates the run', () => {
    // clearState() does not abort the run's job signal, so the run must notice
    // the source changed before it analyzes or renders the old samples.
    expect(workspaceJs).toMatch(/function clearState\(\)\s*\{\s*sourceGeneration \+= 1;/);
    expect(workspaceJs).toContain('const runSource = sourceGeneration;');
    expect(workspaceJs).toMatch(/return runSource !== sourceGeneration\s*\|\|/);
    expect(workspaceJs).toMatch(
      /mono = await downmixToMonoAsync\(channels, \{ signal: downmixSignal\.signal \}\);\s*\} finally \{\s*downmixSignal\.dispose\(\);\s*\}\s*if \(superseded\(\)\) return null;[\s\S]*?host\.analyze\(/
    );
  });

  test('a file change aborts stale downmix and USM packing mid-way', () => {
    expect(workspaceJs).toMatch(/sourceGeneration \+= 1;\s*sourceAbort\.abort\(\);\s*sourceAbort = new AbortController\(\);/);
    expect(workspaceJs).toContain('anySignal([signal, sourceSignal])');
    expect(workspaceJs).toMatch(/usmSourcesToAudioBuffersAsync\(ctx, usmNode\.sources, usmNode\.sampleRate, \{\s*signal: sourceSignal,/);
    // USM binds the source before its first await and drops stale stems.
    expect(workspaceJs).toMatch(
      /async function runUsmBackend[\s\S]*?const sourceSignal = sourceAbort\.signal;[\s\S]*?usmBusy = true;/
    );
    expect(workspaceJs).toMatch(
      /usmNode\.process\(channels, buf\.sampleRate, config\);\s*if \(sourceSignal\.aborted\) \{[\s\S]*?usmNode\.clear\?\.\(\);\s*return null;/
    );
    expect(workspaceJs).toContain('await pushUsmToAudition(sourceSignal, buf);');
    // A decode that lost a file switch must not report "no file loaded".
    expect(workspaceJs).toMatch(/await app\.ensureDecoded\(\);\s*\/\/[^\n]*\n\s*if \(runSource !== sourceGeneration\) return null;/);
  });

  test('every runAnalysis exit settles its job, including stale-source returns', () => {
    expect(workspaceJs).toMatch(
      /\} finally \{\s*(?:\/\/[^\n]*\n\s*)*if \(job && job\.status === 'running' && jobs\?\.endJob\) jobs\.endJob\(job\.id, 'cancelled'\);\s*const activeJob = jobs\?\.getCurrentJob/
    );
  });

  test('superseded analysis releases local busy state unless another analysis owns it', () => {
    expect(workspaceJs).toContain("activeJob.meta?.kind === 'analysis'");
    expect(workspaceJs).toMatch(/if \(!newerAnalysisOwnsWorkspace\)\s*\{[\s\S]*?setBusy\(false\)/);
    expect(workspaceJs).toContain("if (els.root?.dataset.state === 'running') els.root.dataset.state = 'idle';");
    expect(workspaceJs).toContain("app.hideProcessingOverlay(job?.id || null)");
  });
});
