/**
 * Production routing / worklet-path safety (static evidence).
 * Guards against HTML-as-JS and retired worklet URLs.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
const deadWorklet = fs.readFileSync(
  path.join(ROOT, 'public/app/voice-isolate-processor.js'),
  'utf8',
);
const mlHost = fs.readFileSync(path.join(ROOT, 'src/pipeline/MLWorkerHost.js'), 'utf8');
const playback = fs.readFileSync(path.join(ROOT, 'src/pipeline/PlaybackMixer.js'), 'utf8');

describe('Production routing safety', () => {
  test('vercel outputDirectory is public (authoritative deploy source)', () => {
    expect(vercel.outputDirectory).toBe('public');
  });

  test('all /api routes reach the mounted Express handler before the SPA fallback', () => {
    const rewrites = vercel.rewrites || [];
    const apiRewriteIndex = rewrites.findIndex((rule) =>
      rule.source === '/api/:path*' && rule.destination === '/api/handler',
    );
    const spaFallbackIndex = rewrites.findIndex((rule) => rule.destination === '/index.html');

    expect(apiRewriteIndex).toBeGreaterThanOrEqual(0);
    expect(spaFallbackIndex).toBeGreaterThan(apiRewriteIndex);
  });

  test('COOP/COEP isolation headers remain configured', () => {
    const all = JSON.stringify(vercel.headers || []);
    expect(all).toContain('Cross-Origin-Opener-Policy');
    expect(all).toContain('same-origin');
    expect(all).toContain('Cross-Origin-Embedder-Policy');
    expect(all).toContain('require-corp');
  });

  test('global *.js header rule does not force Content-Type (avoids HTML-as-JS)', () => {
    const jsRule = (vercel.headers || []).find((h) => h.source === '/(.*\\.js)');
    expect(jsRule).toBeTruthy();
    const keys = (jsRule.headers || []).map((x) => x.key);
    expect(keys).not.toContain('Content-Type');
    expect(keys).toContain('Cross-Origin-Resource-Policy');
  });

  test('retired voice-isolate-processor is real JS that throws (not SPA HTML)', () => {
    expect(deadWorklet).toMatch(/throw new Error/);
    expect(deadWorklet).toMatch(/retired|removed|GateProcessor/i);
    expect(deadWorklet).not.toMatch(/<!DOCTYPE html>/i);
  });

  test('canonical ML worker path is /src/workers/MLWorker.js', () => {
    expect(mlHost).toContain('/src/workers/MLWorker.js');
    expect(mlHost).not.toMatch(/['"]\/app\/ml-worker\.js['"]/);
  });

  test('playback worklets are Gate + DeEsser only', () => {
    expect(playback).toContain('/src/workers/GateProcessor.js');
    expect(playback).toContain('/src/workers/DeEsserProcessor.js');
  });

  test('microphone is denied in vercel Permissions-Policy', () => {
    const all = JSON.stringify(vercel.headers || []);
    expect(all).toMatch(/microphone=\(\)/);
  });
});
