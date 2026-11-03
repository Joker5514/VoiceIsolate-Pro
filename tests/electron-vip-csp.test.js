/**
 * tests/electron-vip-csp.test.js
 *
 * VIP-025 (IMPLEMENTATION_READINESS_AUDIT_2026-11-02): the vip:// custom
 * protocol now serves a Content Security Policy. Pins:
 *  - strict policy for landing / new surfaces (no inline scripts);
 *  - the web-parity legacy 'unsafe-inline' exception is scoped to exactly
 *    /app, /blueprint, /docs (the Engineer shell still has inline <script>);
 *  - no Google Fonts origins and no CDN model hosts;
 *  - Google auth/Drive origins survive (desktop runs the same flows);
 *  - main.cjs wires the policy into the protocol handler and keeps
 *    bypassCSP: false so Chromium enforces it.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const csp = require('../electron/vip-csp.cjs');

function directives(policy) {
  const out = {};
  for (const part of policy.split(';')) {
    const [name, ...rest] = part.trim().split(/\s+/);
    if (name) out[name] = rest.join(' ');
  }
  return out;
}

describe('vip:// Content Security Policy (VIP-025)', () => {
  test('strict policy carries no inline-script allowance', () => {
    const d = directives(csp.VIP_CSP);
    expect(d['script-src']).not.toContain("'unsafe-inline'");
    expect(d['script-src']).toContain("'self'");
    expect(d['script-src']).toContain("'wasm-unsafe-eval'");
  });

  test('policy keeps WASM, workers, auth and Drive flows working', () => {
    const d = directives(csp.VIP_CSP);
    expect(d['worker-src']).toContain("'self'");
    expect(d['worker-src']).toContain("'wasm-unsafe-eval'");
    expect(d['connect-src']).toContain('https://www.googleapis.com');
    expect(d['connect-src']).toContain('https://identitytoolkit.googleapis.com');
    expect(d['frame-src']).toContain('https://accounts.google.com');
    expect(d['frame-src']).toContain('https://docs.google.com');
    expect(d['default-src']).toBe("'self'");
  });

  test('policy never references Google Fonts or CDN model hosts', () => {
    expect(csp.VIP_CSP).not.toContain('fonts.googleapis.com');
    expect(csp.VIP_CSP).not.toContain('fonts.gstatic.com');
    expect(csp.VIP_CSP).not.toContain('blob.vercel-storage.com');
  });

  test('legacy inline exception is scoped to exactly /app, /blueprint, /docs', () => {
    expect(csp.isLegacyInlinePath('/app')).toBe(true);
    expect(csp.isLegacyInlinePath('/app/index.html')).toBe(true);
    expect(csp.isLegacyInlinePath('/app/')).toBe(true);
    expect(csp.isLegacyInlinePath('/blueprint/x.html')).toBe(true);
    expect(csp.isLegacyInlinePath('/docs/guide.html')).toBe(true);
    // Boundaries: sibling paths must NOT get the exception.
    expect(csp.isLegacyInlinePath('/index.html')).toBe(false);
    expect(csp.isLegacyInlinePath('/apple/index.html')).toBe(false);
    expect(csp.isLegacyInlinePath('/download/index.html')).toBe(false);
    expect(csp.isLegacyInlinePath('/')).toBe(false);
  });

  test('legacy scope grants the same temporary exception the web grants', () => {
    const legacy = directives(csp.vipSecurityHeaders('vip://app/app/index.html')['Content-Security-Policy']);
    const strict = directives(csp.vipSecurityHeaders('vip://app/index.html')['Content-Security-Policy']);
    expect(legacy['script-src']).toContain("'unsafe-inline'");
    expect(strict['script-src']).not.toContain("'unsafe-inline'");
    // Everything else is identical: the exception is the only difference.
    expect({ ...legacy, 'script-src': undefined }).toEqual({ ...strict, 'script-src': undefined });
  });

  test('every response gets the hardening header set', () => {
    const headers = csp.vipSecurityHeaders('vip://app/index.html');
    expect(headers['Cross-Origin-Opener-Policy']).toBe('same-origin');
    expect(headers['Cross-Origin-Embedder-Policy']).toBe('require-corp');
    expect(headers['Cross-Origin-Resource-Policy']).toBe('same-origin');
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['Content-Security-Policy']).toContain("object-src 'none'");
    expect(headers['Content-Security-Policy']).toContain("frame-ancestors 'none'");
  });
});

describe('main.cjs wiring', () => {
  const src = fs.readFileSync(path.join(ROOT, 'electron', 'main.cjs'), 'utf8');

  test('protocol handler sets the CSP from vip-csp.cjs', () => {
    expect(src).toMatch(/require\('\.\/vip-csp\.cjs'\)/);
    expect(src).toMatch(/vipSecurityHeaders\(request\.url\)/);
  });

  test('CSP is enforced (bypassCSP stays false)', () => {
    expect(src).toMatch(/bypassCSP:\s*false/);
  });

  test('the hardened SAM proxy is still the only renderer path to the local worker', () => {
    expect(src).toMatch(/sam-proxy\.cjs/);
  });
});
