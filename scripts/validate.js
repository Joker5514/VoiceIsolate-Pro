#!/usr/bin/env node
/**
 * VoiceIsolate Pro — Structural Validation
 * Checks critical files, architecture patterns, and slider definitions.
 */
const fs = require('fs');
const path = require('path');

let errors = 0;
const check = (condition, msg) => {
  if (condition) { console.log(`  ✓ ${msg}`); }
  else { console.log(`  ✗ ${msg}`); errors++; }
};

console.log('\n🔍 VoiceIsolate Pro — Validation\n');

// 1. Critical files
console.log('Files:');
const required = [
  'public/index.html',
  'public/app/index.html',
  'public/app/style.css',
  'public/app/app.js',
  'public/app/dsp-worker.js',           // Phase 3: AudioWorklet
  'public/app/ml-worker.js',            // Phase 4: ML Web Worker
  'public/app/models/README.md',        // Phase 4: ML model docs
  'public/blueprint/index.html',
  'vercel.json',
  'package.json',
  'README.md',
  '.github/copilot-instructions.md',
  'tests/dsp.test.js',                  // Phase 6: Tests
  'tests/sliders.test.js',
  'tests/presets.test.js',
];
required.forEach(f => check(fs.existsSync(path.resolve(__dirname, '..', f)), f));

// 2. app.js structural checks
console.log('\napp.js structure:');
const appJs = fs.readFileSync(path.resolve(__dirname, '..', 'public/app/app.js'), 'utf8');
check(appJs.length > 10000, `Size: ${appJs.length} bytes (>10KB)`);

const sliderGroups = ['gate', 'nr', 'eq'];
sliderGroups.forEach(g => check(appJs.includes(`${g}:`), `Slider group: ${g}`));

// Count slider definitions
const sliderMatches = appJs.match(/id:\s*'/g);
const sliderCount = sliderMatches ? sliderMatches.length : 0;
check(sliderCount >= 52, `Slider count: ${sliderCount} (>=52)`);

// Count STAGES
const stagesMatch = appJs.match(/const STAGES = \[([\s\S]*?)\];/);
const stageItems = stagesMatch ? (stagesMatch[1].match(/'[^']+'/g) || []) : [];
check(stageItems.length === 32, `STAGES count: ${stageItems.length} (must be 32)`);

// Phase 1: STFT engine presence
console.log('\nSpectral Engine (Phase 1):');
check(appJs.includes('_fft(re, im)'), 'FFT implementation present');
check(appJs.includes('_ifft(re, im)'), 'IFFT implementation present');
check(appJs.includes('_makeWindow(N)'), 'Blackman-Harris window present');
check(appJs.includes('applySpectralNR'), 'Spectral NR function present');
check(!appJs.includes('applyNR(buf,amt,smooth'), 'Old stub applyNR removed');

// Phase 2: Wired sliders
console.log('\nWired Sliders (Phase 2):');
const wiredSliders = ['applyBgSuppress','applyCrosstalkCancel','applyFormantShift','applyPhaseCorr','applyDereverb','applyDither'];
wiredSliders.forEach(fn => check(appJs.includes(fn), `${fn} implemented`));

// Phase 3: AudioWorklet
console.log('\nAudioWorklet (Phase 3):');
const workerJs = fs.existsSync(path.resolve(__dirname, '..', 'public/app/dsp-worker.js'))
  ? fs.readFileSync(path.resolve(__dirname, '..', 'public/app/dsp-worker.js'), 'utf8') : '';
check(workerJs.includes("registerProcessor('voice-isolate-processor'"), 'AudioWorklet registerProcessor present');
check(workerJs.includes('process(inputs, outputs)'), 'AudioWorklet process() method present');
check(appJs.includes("addModule('./dsp-worker.js')"), 'AudioWorklet registered in ensureCtx');

// Phase 4: ONNX Runtime + ML Worker
console.log('\nONNX Runtime (Phase 4):');
const htmlPath = path.resolve(__dirname, '..', 'public/app/index.html');
const html = fs.existsSync(htmlPath) ? fs.readFileSync(htmlPath, 'utf8') : '';
const mlWorkerJs = fs.existsSync(path.resolve(__dirname, '..', 'public/app/ml-worker.js'))
  ? fs.readFileSync(path.resolve(__dirname, '..', 'public/app/ml-worker.js'), 'utf8') : '';
check(html.includes('onnxruntime-web'), 'ONNX Runtime CDN in index.html');
check(appJs.includes('async loadModels()'), 'loadModels() method present');
check(appJs.includes('async runVAD(buf)'), 'runVAD() method present');
check(appJs.includes('initMLWorker()'), 'ML Worker spawned in app.js');
check(appJs.includes("new Worker('./ml-worker.js')"), 'ML Worker path correct');
check(mlWorkerJs.includes("type === 'init'") || mlWorkerJs.includes("case 'runVAD':"), 'ML Worker handles init/runVAD');
check(mlWorkerJs.includes("type === 'process'") || mlWorkerJs.includes("case 'runSeparation':"), 'ML Worker handles process/runSeparation');
check(mlWorkerJs.includes("type === 'reset'") || mlWorkerJs.includes("case 'runVocoder':"), 'ML Worker handles reset/runVocoder');
check(mlWorkerJs.includes('importScripts'), 'ML Worker loads ORT via importScripts');

// Phase 5: Forensic
console.log('\nForensic Mode (Phase 5):');
check(html.includes('forensicToggle'), 'Forensic toggle in index.html');
check(html.includes('auditLogBtn'), 'Audit log button in index.html');
check(appJs.includes("crypto.subtle.digest('SHA-256'"), 'SHA-256 audit hashing present');
check(appJs.includes('this.forensicLog = []'), 'forensicLog initialized');

// 3. Balanced braces
console.log('\nBrace balance:');
const openBraces = (appJs.match(/{/g) || []).length;
const closeBraces = (appJs.match(/}/g) || []).length;
check(openBraces === closeBraces, `Braces: ${openBraces} open / ${closeBraces} close`);

// 4. Blueprint check
console.log('\nBlueprint:');
const blueprint = fs.readFileSync(path.resolve(__dirname, '..', 'public/blueprint/index.html'), 'utf8');
check(blueprint.includes('Octa-Pass'), 'Contains Octa-Pass pipeline reference');
check(blueprint.includes('32'), 'References 32 stages');
check(blueprint.includes('Threads from Space'), 'Threads from Space architecture');

// 5. Duplicate JSON key check
console.log('\nJSON duplicate key check:');
function checkDuplicateKeys(filePath) {
  const raw = fs.readFileSync(path.resolve(__dirname, '..', filePath), 'utf8');
  const dupes = [];
  // Tokenize the JSON string, correctly skipping over string contents
  // so that braces/brackets inside strings are never counted as structure.
  const stack = [new Set()]; // stack of key-sets, one per object nesting level
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    // Skip whitespace
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { i++; continue; }
    // String literal — advance past the entire string, handling escapes
    if (ch === '"') {
      const start = i;
      i++; // skip opening quote
      while (i < raw.length && raw[i] !== '"') {
        if (raw[i] === '\\') i++; // skip escaped char
        i++;
      }
      i++; // skip closing quote
      // Check if this string is a key (followed by ':')
      let j = i;
      while (j < raw.length && (raw[j] === ' ' || raw[j] === '\t' || raw[j] === '\n' || raw[j] === '\r')) j++;
      if (j < raw.length && raw[j] === ':') {
        const key = raw.slice(start + 1, i - 1);
        const currentLevel = stack[stack.length - 1];
        if (currentLevel.has(key)) {
          dupes.push(key);
        }
        currentLevel.add(key);
        i = j + 1; // skip past ':'
      }
      continue;
    }
    // Object open — push a new key-set scope
    if (ch === '{') { stack.push(new Set()); i++; continue; }
    // Object close — pop key-set scope
    if (ch === '}') { if (stack.length > 1) stack.pop(); i++; continue; }
    // Array open/close — push/pop a scope so nested objects inside arrays
    // each get their own key tracking (the set will simply stay empty for arrays)
    if (ch === '[') { stack.push(new Set()); i++; continue; }
    if (ch === ']') { if (stack.length > 1) stack.pop(); i++; continue; }
    // Skip all other characters (numbers, booleans, null, commas, colons)
    i++;
  }
  return dupes;
}
const pkgDupes = checkDuplicateKeys('package.json');
check(pkgDupes.length === 0, pkgDupes.length === 0
  ? 'No duplicate keys in package.json'
  : `Duplicate keys in package.json: ${pkgDupes.join(', ')}`);

// 6. vercel.json
console.log('\nVercel config:');
const vercelJson = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'vercel.json'), 'utf8'));
check(vercelJson.outputDirectory === 'public', 'Output directory: public');

console.log(`\n${errors === 0 ? '✅ All checks passed' : `❌ ${errors} check(s) failed`}\n`);
process.exit(errors > 0 ? 1 : 0);
