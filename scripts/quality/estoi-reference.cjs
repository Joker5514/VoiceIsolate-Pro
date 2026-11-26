'use strict';
/**
 * MET-01 reference harness: compare the JS STOI/ESTOI implementation in
 * scripts/quality/lib/metrics.cjs against the pinned pystoi 0.4.1
 * outputs in scripts/quality/fixtures/estoi/manifest.json.
 *
 *   node scripts/quality/estoi-reference.cjs            # compare only
 *   node scripts/quality/estoi-reference.cjs --generate # regenerate
 *     fixtures first (needs .venv-estoi; see estoi-requirements.txt)
 *
 * Exit code 0 iff every non-exempt fixture satisfies
 * |JS - reference| <= 1e-4 for both STOI and ESTOI. Fixtures marked
 * toleranceExempt in the manifest (silence: the reference itself is
 * non-deterministic there) are reported, not compared.
 */
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { stoi, estoi } = require('./lib/metrics.cjs');

const DIR = path.join(__dirname, 'fixtures', 'estoi');
const MANIFEST = path.join(DIR, 'manifest.json');
const TOLERANCE = 1e-4;

function readF64(file) {
  const buf = fs.readFileSync(path.join(DIR, file));
  if (buf.length % 8 !== 0) throw new Error(`${file}: byte length ${buf.length} is not a multiple of 8`);
  const out = new Float64Array(buf.length / 8);
  for (let i = 0; i < out.length; i++) out[i] = buf.readDoubleLE(i * 8);
  return out;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(path.join(DIR, file))).digest('hex');
}

function main() {
  const generate = process.argv.includes('--generate');
  if (generate) {
    const venvPython = path.join(__dirname, '..', '..', '.venv-estoi', 'bin', 'python');
    if (!fs.existsSync(venvPython)) {
      console.error(`BLOCKED: reference venv python not found at ${venvPython}.\nCreate it with:\n  python3 -m venv /home/hatch/vip-verify/.venv-estoi\n  /home/hatch/vip-verify/.venv-estoi/bin/python -m pip install -r scripts/quality/estoi-requirements.txt`);
      process.exit(2);
    }
    execFileSync(venvPython, [path.join(__dirname, 'estoi-oracle.py')], { stdio: 'inherit' });
  }

  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  console.log(`pystoi ${manifest.pystoi} / numpy ${manifest.numpy} / scipy ${manifest.scipy} (seed ${manifest.seed})`);
  console.log(`tolerance: |JS - reference| <= ${TOLERANCE}\n`);

  let failed = 0;
  let compared = 0;
  for (const fx of manifest.fixtures) {
    const ref = readF64(fx.refFile);
    const deg = readF64(fx.degFile);
    if (ref.length !== fx.samples || deg.length !== fx.samples) {
      console.log(`${fx.name}: FAIL fixture length ${ref.length}/${deg.length} != manifest ${fx.samples}`);
      failed++;
      continue;
    }
    if (sha256(fx.refFile) !== fx.refSha256 || sha256(fx.degFile) !== fx.degSha256) {
      console.log(`${fx.name}: FAIL fixture sha256 mismatch — regenerate with estoi-oracle.py`);
      failed++;
      continue;
    }
    const jsStoi = stoi(ref, deg, fx.sampleRate);
    const jsEstoi = estoi(ref, deg, fx.sampleRate);
    if (fx.toleranceExempt) {
      console.log(`${fx.name}: EXEMPT (${fx.toleranceExemptReason})\n  JS stoi=${jsStoi} estoi=${jsEstoi} | reference stoi=${fx.stoi} estoi=${fx.estoi}`);
      continue;
    }
    compared++;
    const dStoi = Math.abs(jsStoi - fx.stoi);
    const dEstoi = Math.abs(jsEstoi - fx.estoi);
    const ok = dStoi <= TOLERANCE && dEstoi <= TOLERANCE;
    if (!ok) failed++;
    console.log(`${fx.name}: ${ok ? 'PASS' : 'FAIL'} | dStoi=${dStoi.toExponential(2)} dEstoi=${dEstoi.toExponential(2)} (JS stoi=${jsStoi.toFixed(9)} estoi=${jsEstoi.toFixed(9)}; ref stoi=${fx.stoi.toFixed(9)} estoi=${fx.estoi.toFixed(9)})`);
  }
  console.log(`\n${compared - failed}/${compared} fixtures within tolerance${failed ? ` — ${failed} FAILED` : ''}`);
  process.exit(failed ? 1 : 0);
}

main();
