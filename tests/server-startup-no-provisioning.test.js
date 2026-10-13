/**
 * F11 — starting the server must never provision models. The previous
 * server.js spawned `node scripts/upload-to-vercel-blob.mjs` whenever
 * BLOB_READ_WRITE_TOKEN was set (network writes + a manifest rewrite). This
 * boots the real server with a fake token and a stub `node` first on PATH that
 * only records its arguments; nothing reaches Vercel Blob.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');

test('server start-up with a Blob token spawns no uploader', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vip-f11-'));
  const marker = path.join(dir, 'spawned.txt');
  const stub = path.join(dir, 'node');
  fs.writeFileSync(stub, `#!/bin/sh\necho "$@" >> "${marker}"\n`, { mode: 0o755 });
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PATH: `${dir}${path.delimiter}${process.env.PATH}`,
      BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_fake_for_test',
      NODE_ENV: 'development',
      PORT: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(resolve, 2500);
      child.on('exit', (code) => { clearTimeout(t); reject(new Error(`server exited early (${code}): ${out}`)); });
    });
    expect(out).toMatch(/running on port/);
    expect(fs.existsSync(marker)).toBe(false);
    expect(out).not.toMatch(/setup-blob/);
  } finally {
    child.kill('SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 15000);

test('the uploader makes no network calls and writes nothing without --yes', () => {
  const { spawnSync } = require('child_process');
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'vip-upl-'));
  // Any network API the script could reach throws, and the attempt is recorded.
  const trap = path.join(dir, 'trap.mjs');
  fs.writeFileSync(trap, `
    import http from 'node:http'; import https from 'node:https'; import net from 'node:net';
    const hit = (what) => { process.stderr.write('NETWORK:' + what + '\\n'); throw new Error('network blocked'); };
    globalThis.fetch = () => hit('fetch');
    for (const m of [http, https]) { m.request = () => hit('request'); m.get = () => hit('get'); }
    net.connect = net.createConnection = () => hit('connect');
  `);
  const manifest = path.join(ROOT, 'public/app/models-manifest.json');
  const before = fs.readFileSync(manifest);
  try {
    const r = spawnSync(process.execPath, ['--import', trap, path.join(ROOT, 'scripts/upload-to-vercel-blob.mjs')], {
      cwd: ROOT, encoding: 'utf8', env: { ...process.env, BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_test_not_real' },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/dry run/);
    expect(r.stderr).not.toMatch(/NETWORK:/);
    expect(fs.readFileSync(manifest).equals(before)).toBe(true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const src = fs.readFileSync(path.join(ROOT, 'scripts/upload-to-vercel-blob.mjs'), 'utf8');
  expect(src).toMatch(/does not match ModelManifest pin/);
});
