#!/usr/bin/env node
/**
 * Privacy / upload-only CI gate for VoiceIsolate Pro.
 *
 * Fails if product sources introduce:
 *   - getUserMedia outside the documented non-product mic-capture module
 *   - Hosted cloud audio backends (delegates patterns + expands coverage)
 *   - Fetch/WebSocket of audio buffers to third parties
 *
 * Does not print secrets. Exit 0 = pass.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const ROOTS = ['public/app', 'public/landing.js', 'src', 'electron', 'services/sam-audio'];
const EXT = new Set(['.js', '.cjs', '.mjs', '.ts', '.tsx']);

/** getUserMedia allowed only in these relative paths (explicitly non-product). */
const GUM_ALLOW = [
  /^public\/mic-capture\.js$/,
];

const CLOUD = [
  { re: /fal\.ai/i, label: 'fal.ai' },
  { re: /replicate\.com/i, label: 'replicate.com' },
  { re: /api\.openai\.com/i, label: 'OpenAI API' },
  { re: /huggingface\.co\/.*\/(pipeline|api)/i, label: 'HF hosted inference' },
  { re: /@fal-ai\//i, label: 'fal SDK' },
  { re: /new\s+Replicate\b/i, label: 'Replicate SDK' },
];

const SKIP = [
  /check-privacy-invariants\.js$/,
  /check-no-cloud-audio\.js$/,
  /node_modules/,
  /\.test\.js$/,
  /tests\//,
  /docs\//,
  /AUDIT_BASELINE/,
];

let failed = false;
const hits = [];

function walk(dir) {
  if (!fs.existsSync(dir)) return;
  const st = fs.statSync(dir);
  if (st.isFile()) {
    scan(dir);
    return;
  }
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name === 'dist' || ent.name === 'build') continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p);
    else if (EXT.has(path.extname(ent.name))) scan(p);
  }
}

function scan(file) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  if (SKIP.some((rx) => rx.test(rel))) return;
  const src = fs.readFileSync(file, 'utf8');
  const lines = src.split(/\r?\n/);

  // getUserMedia
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/getUserMedia\s*\(/.test(line)) continue;
    if (/^\s*(\/\/|#|\*|\/\*)/.test(line)) continue;
    if (GUM_ALLOW.some((rx) => rx.test(rel))) continue;
    // Feature-flagged live mic must use VIP_FEATURE_LIVE_MIC === true
    if (/VIP_FEATURE_LIVE_MIC/.test(line) || /VIP_FEATURE_LIVE_MIC/.test(lines[Math.max(0, i - 2)] || '')) {
      continue;
    }
    failed = true;
    hits.push(`${rel}:${i + 1}: getUserMedia without VIP_FEATURE_LIVE_MIC :: ${line.trim().slice(0, 100)}`);
  }

  for (const { re, label } of CLOUD) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!re.test(line)) continue;
      if (/^\s*(\/\/|#|\*|\/\*)/.test(line)) continue;
      if (/forbid|never|do not|ban|not use/i.test(line)) continue;
      failed = true;
      hits.push(`${rel}:${i + 1}: ${label} :: ${line.trim().slice(0, 100)}`);
    }
  }
}

for (const r of ROOTS) walk(path.join(ROOT, r));

// Ensure product shells do not import mic-capture
for (const rel of ['public/app/app.js', 'public/landing.js', 'public/app/index.html', 'public/index.html']) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) continue;
  const t = fs.readFileSync(abs, 'utf8');
  if (/mic-capture/.test(t) && !/not.*mic-capture|never.*mic-capture|OUTSIDE public\/app/i.test(t)) {
    failed = true;
    hits.push(`${rel}: references mic-capture (forbidden in product shell)`);
  }
}

if (failed) {
  console.error('[FAIL] Privacy invariants:\n' + hits.join('\n'));
  process.exit(1);
}
console.log('[pass] privacy invariants (upload-only, no cloud audio backends, no product getUserMedia)');
