/**
 * VoiceIsolate Pro — Audio Upload Bug-Fix Regression Tests
 *
 * Covers three issues fixed in landing.js:
 *   1. Race condition: fileInput must be disabled during ingestion so that
 *      rapid file selections cannot start concurrent ingestFile() calls.
 *   2. Same-file re-upload: fileInput.value is reset after every ingestion
 *      attempt (success or failure) so the browser fires 'change' again
 *      when the user re-selects the same file.
 *   3. Drag-and-drop: the upload panel handles dragover/dragleave/drop so
 *      users can drop audio/video files directly onto the panel.
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT  = path.join(__dirname, '..');
const html  = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const js    = fs.readFileSync(path.join(ROOT, 'public/landing.js'), 'utf8');
const css   = fs.readFileSync(path.join(ROOT, 'public/landing.css'), 'utf8');

// ── Bug 1: race condition guard ───────────────────────────────────────────────

describe('Upload race condition guard', () => {
  test('ingestFrom() disables the file input before awaiting ingestFile()', () => {
    // The fix: ui.fileInput.disabled = true must appear inside ingestFrom,
    // before the await, so a second file-picker open is impossible mid-decode.
    expect(js).toContain('ui.fileInput.disabled = true');
  });

  test('ingestFrom() bails early when fileInput is already disabled', () => {
    // Covers drag-and-drop concurrent calls AND drops during onProcess()
    // (which also sets fileInput.disabled = true).
    expect(js).toMatch(/if\s*\(!file\s*\|\|\s*ui\.fileInput\.disabled\)/);
  });

  test('file input is re-enabled in a finally block (always runs)', () => {
    // Both success and error paths must restore the input; only a finally
    // block guarantees this.
    expect(js).toMatch(/finally\s*\{[^}]*ui\.fileInput\.disabled\s*=\s*false/s);
  });

  test('onFileChosen() delegates to ingestFrom()', () => {
    // onFileChosen is now a thin wrapper so drag-and-drop can share the logic.
    expect(js).toContain('function ingestFrom(');
    expect(js).toContain('async function onFileChosen()');
    expect(js).toContain('ingestFrom(ui.fileInput.files');
  });
});

// ── Bug 2: same-file re-selection ────────────────────────────────────────────

describe('Upload validation and mobile gesture', () => {
  test('ingestFrom validates the file before disabling the input', () => {
    expect(js).toContain('assertIngestible(file)');
    expect(js).toMatch(/assertIngestible\(file\)[\s\S]*ingestSeq/);
  });

  test('ingestFrom primes audio gesture before decode', () => {
    expect(js).toMatch(/ingestFrom[\s\S]*primeAudioGesture[\s\S]*ingestFile/);
  });

  test('drag-and-drop primes the audio gesture before ingest', () => {
    expect(js).toContain('primeAudioGesture');
    expect(js).toMatch(/drop[\s\S]*primeAudioGesture[\s\S]*ingestFrom\(file\)/);
  });
});

describe('Same-file re-upload', () => {
  test("fileInput.value is reset to '' after every ingestion attempt", () => {
    // Without this reset the browser won't fire 'change' for the same file.
    expect(js).toContain("ui.fileInput.value = ''");
  });

  test('the reset happens in the finally block (also runs after errors)', () => {
    expect(js).toMatch(/finally\s*\{[^}]*ui\.fileInput\.value\s*=\s*''/s);
  });
});

// ── Bug 3: drag-and-drop ─────────────────────────────────────────────────────

describe('Drag-and-drop upload', () => {
  test('index.html gives the upload panel an id so JS can attach listeners', () => {
    expect(html).toContain('id="uploadPanel"');
  });

  test('landing.js references uploadPanel in the ui map', () => {
    expect(js).toContain("uploadPanel: $('uploadPanel')");
  });

  test('wireDragAndDrop() function is defined', () => {
    expect(js).toContain('function wireDragAndDrop()');
  });

  test('wireDragAndDrop() is called at boot', () => {
    expect(js).toContain('wireDragAndDrop()');
    // Must appear after the function definition, not just be defined.
    const defIdx  = js.indexOf('function wireDragAndDrop()');
    const callIdx = js.lastIndexOf('wireDragAndDrop()');
    expect(callIdx).toBeGreaterThan(defIdx);
  });

  test('dragover handler calls preventDefault() (prevents browser navigation)', () => {
    expect(js).toMatch(/dragover[^}]*preventDefault\(\)/s);
  });

  test('dragleave handler does not rely on relatedTarget (unreliable in Safari)', () => {
    // pointer-events:none on children makes relatedTarget unnecessary.
    expect(js).not.toContain('e.relatedTarget');
  });

  test('CSS prevents child elements from absorbing drag events (Safari fix)', () => {
    expect(css).toContain('.upload-panel--dragging *');
    expect(css).toContain('pointer-events: none');
  });

  test('drop handler calls preventDefault() and reads dataTransfer.files', () => {
    expect(js).toMatch(/drop[^}]*preventDefault\(\)/s);
    expect(js).toContain('dataTransfer');
    expect(js).toContain('dataTransfer.files');
  });

  test('drop handler passes the file to ingestFrom()', () => {
    expect(js).toMatch(/drop[^}]*ingestFrom\(file\)/s);
  });

  test('landing.css defines the dragging visual state', () => {
    expect(css).toContain('.upload-panel--dragging');
    expect(css).toContain('#uploadPanel');
  });

  test('dragging class is added on dragover and removed on drop/dragleave', () => {
    expect(js).toContain("classList.add('upload-panel--dragging')");
    expect(js).toContain("classList.remove('upload-panel--dragging')");
  });
});
