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
  'public/blueprint/index.html',
  'vercel.json',
  'package.json',
  'README.md',
  '.github/copilot-instructions.md',
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
check(sliderCount >= 40, `Slider count: ${sliderCount} (>=40)`);

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

// 5. vercel.json
console.log('\nVercel config:');
const vercelJson = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'vercel.json'), 'utf8'));
check(vercelJson.outputDirectory === 'public', 'Output directory: public');

console.log(`\n${errors === 0 ? '✅ All checks passed' : `❌ ${errors} check(s) failed`}\n`);
process.exit(errors > 0 ? 1 : 0);
