#!/usr/bin/env node
/**
 * Fail CI if processing code introduces hosted audio backends or external
 * SAM/cloud inference (fal, Replicate, public HF inference APIs, etc.).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const ROOTS = ['public/app', 'src', 'electron', 'services/sam-audio', 'api-routes'];
const EXT = new Set(['.js', '.cjs', '.mjs', '.ts', '.tsx', '.py']);

const FORBIDDEN = [
  { re: /fal\.ai/i, label: 'fal.ai' },
  { re: /replicate\.com/i, label: 'replicate.com' },
  { re: /api\.openai\.com/i, label: 'OpenAI API' },
  { re: /huggingface\.co\/.*\/pipeline/i, label: 'HF inference pipeline URL' },
  { re: /new\s+Replicate\b/i, label: 'Replicate SDK' },
  { re: /@fal-ai\//i, label: 'fal SDK' },
];

// Allowlist: docs and comments may mention forbidden names.
const SKIP_FILES = [
  /check-no-cloud-audio\.js$/,
  /CROSS_PLATFORM_SAM_AUDIT/,
  /SAM_AUDIO\.md$/,
  /services\/sam-audio\/README/,
];

let failed = false;
const hits = [];

function walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name === 'dist' || ent.name === 'build') continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p);
    else if (EXT.has(path.extname(ent.name))) scan(p);
  }
}

function scan(file) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  if (SKIP_FILES.some((rx) => rx.test(rel))) return;
  const src = fs.readFileSync(file, 'utf8');
  // Strip block comments roughly for py/js
  for (const { re, label } of FORBIDDEN) {
    if (re.test(src)) {
      // Ignore pure documentation lines starting with # or * mentioning policy
      const lines = src.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (re.test(line) && !/^\s*(\/\/|#|\*|\/\*)/.test(line) && !/forbid|never|do not|ban/i.test(line)) {
          failed = true;
          hits.push(`${rel}:${i + 1}: ${label} :: ${line.trim().slice(0, 120)}`);
        }
      }
    }
  }
}

for (const r of ROOTS) walk(path.join(ROOT, r));

if (failed) {
  console.error('[FAIL] Cloud/hosted audio patterns found:\n' + hits.join('\n'));
  process.exit(1);
}
console.log('[pass] no hosted cloud audio backends in processing sources');
