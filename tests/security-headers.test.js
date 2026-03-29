/**
 * Tests for security header configuration changes in the CSP hardening PR.
 * Covers: vercel.json, render.yaml, and .jules/sentinel.md
 *
 * Key changes validated:
 *  - `wasm-unsafe-eval` removed from script-src in both deployment configs
 *  - `https://cdnjs.cloudflare.com` added to vercel.json script-src
 *  - Duplicate CSP entry removed from render.yaml
 *  - Corresponding sentinel.md section removed
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function readFile(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

function fileExists(relPath) {
  return fs.existsSync(path.join(ROOT, relPath));
}

/**
 * Parse the CSP directive value from vercel.json by finding the
 * Content-Security-Policy header entry in the headers array.
 */
function getVercelCspValue() {
  const config = JSON.parse(readFile('vercel.json'));
  for (const route of config.headers) {
    for (const header of route.headers) {
      if (header.key === 'Content-Security-Policy') {
        return header.value;
      }
    }
  }
  return null;
}

/**
 * Parse the CSP directive value from render.yaml using a regex.
 * The relevant line has the form:
 *   value: "default-src 'self'; ..."
 * following a `name: Content-Security-Policy` line.
 */
function getRenderCspValue() {
  const content = readFile('render.yaml');
  // Find the block: name: Content-Security-Policy  followed by  value: "..."
  const match = content.match(/name:\s*Content-Security-Policy\s*\n\s*value:\s*"([^"]+)"/);
  return match ? match[1] : null;
}

// ─── vercel.json — Content-Security-Policy ───────────────────────────────────

describe('vercel.json — Content-Security-Policy header', () => {
  let cspValue;

  beforeAll(() => {
    cspValue = getVercelCspValue();
  });

  test('vercel.json exists and is valid JSON', () => {
    expect(fileExists('vercel.json')).toBe(true);
    expect(() => JSON.parse(readFile('vercel.json'))).not.toThrow();
  });

  test('Content-Security-Policy header entry is present', () => {
    expect(cspValue).not.toBeNull();
    expect(typeof cspValue).toBe('string');
    expect(cspValue.length).toBeGreaterThan(0);
  });

  // ── Core change: wasm-unsafe-eval removed ──────────────────────────────────

  test('wasm-unsafe-eval is NOT present in script-src (removed by this PR)', () => {
    expect(cspValue).not.toContain('wasm-unsafe-eval');
  });

  // ── Core change: cdnjs.cloudflare.com added ────────────────────────────────

  test('https://cdnjs.cloudflare.com IS present in script-src (added by this PR)', () => {
    const scriptSrc = cspValue.match(/script-src([^;]+)/);
    expect(scriptSrc).not.toBeNull();
    expect(scriptSrc[1]).toContain('https://cdnjs.cloudflare.com');
  });

  // ── Existing allowlist entries preserved ──────────────────────────────────

  test("script-src contains 'self'", () => {
    expect(cspValue).toContain("script-src 'self'");
  });

  test("script-src contains 'unsafe-inline'", () => {
    const scriptSrc = cspValue.match(/script-src([^;]+)/);
    expect(scriptSrc).not.toBeNull();
    expect(scriptSrc[1]).toContain("'unsafe-inline'");
  });

  test('script-src contains https://cdn.jsdelivr.net', () => {
    const scriptSrc = cspValue.match(/script-src([^;]+)/);
    expect(scriptSrc).not.toBeNull();
    expect(scriptSrc[1]).toContain('https://cdn.jsdelivr.net');
  });

  test('script-src contains /_vercel path', () => {
    const scriptSrc = cspValue.match(/script-src([^;]+)/);
    expect(scriptSrc).not.toBeNull();
    expect(scriptSrc[1]).toContain('/_vercel');
  });

  // ── Required CSP directives ────────────────────────────────────────────────

  test("default-src is 'self'", () => {
    expect(cspValue).toContain("default-src 'self'");
  });

  test('style-src is defined', () => {
    expect(cspValue).toContain('style-src');
  });

  test('font-src is defined', () => {
    expect(cspValue).toContain('font-src');
  });

  test('img-src is defined', () => {
    expect(cspValue).toContain('img-src');
  });

  test('media-src is defined', () => {
    expect(cspValue).toContain('media-src');
  });

  test('connect-src is defined', () => {
    expect(cspValue).toContain('connect-src');
  });

  test('worker-src is defined', () => {
    expect(cspValue).toContain('worker-src');
  });

  test('worker-src allows blob: (required for audio workers)', () => {
    const workerSrc = cspValue.match(/worker-src([^;]+)/);
    expect(workerSrc).not.toBeNull();
    expect(workerSrc[1]).toContain('blob:');
  });

  test('img-src allows data: and blob: (required for audio waveform rendering)', () => {
    const imgSrc = cspValue.match(/img-src([^;]+)/);
    expect(imgSrc).not.toBeNull();
    expect(imgSrc[1]).toContain('data:');
    expect(imgSrc[1]).toContain('blob:');
  });

  // ── No duplicate CSP headers ───────────────────────────────────────────────

  test('exactly one Content-Security-Policy header entry exists per route', () => {
    const config = JSON.parse(readFile('vercel.json'));
    for (const route of config.headers) {
      const cspHeaders = route.headers.filter(h => h.key === 'Content-Security-Policy');
      expect(cspHeaders.length).toBeLessThanOrEqual(1);
    }
  });

  // ── Boundary / negative ────────────────────────────────────────────────────

  test('unsafe-eval is NOT present (broader eval restriction)', () => {
    expect(cspValue).not.toContain("'unsafe-eval'");
  });

  test('connect-src includes https://cdn.jsdelivr.net', () => {
    const connectSrc = cspValue.match(/connect-src([^;]+)/);
    expect(connectSrc).not.toBeNull();
    expect(connectSrc[1]).toContain('https://cdn.jsdelivr.net');
  });
});

// ─── vercel.json — other security headers (structure sanity) ─────────────────

describe('vercel.json — overall security header structure', () => {
  let config;

  beforeAll(() => {
    config = JSON.parse(readFile('vercel.json'));
  });

  test('headers array is non-empty', () => {
    expect(Array.isArray(config.headers)).toBe(true);
    expect(config.headers.length).toBeGreaterThan(0);
  });

  test('global route (source "/(.*)" or similar) exists with security headers', () => {
    const globalRoute = config.headers.find(r =>
      r.source === '/(.*)' || r.source === '/(.*)'
    );
    expect(globalRoute).toBeDefined();
    expect(Array.isArray(globalRoute.headers)).toBe(true);
  });

  test('X-Frame-Options header is present', () => {
    const globalRoute = config.headers.find(r => r.source === '/(.*)');
    const header = globalRoute.headers.find(h => h.key === 'X-Frame-Options');
    expect(header).toBeDefined();
    expect(header.value).toBe('DENY');
  });

  test('X-Content-Type-Options header is present', () => {
    const globalRoute = config.headers.find(r => r.source === '/(.*)');
    const header = globalRoute.headers.find(h => h.key === 'X-Content-Type-Options');
    expect(header).toBeDefined();
    expect(header.value).toBe('nosniff');
  });

  test('Referrer-Policy header is present', () => {
    const globalRoute = config.headers.find(r => r.source === '/(.*)');
    const header = globalRoute.headers.find(h => h.key === 'Referrer-Policy');
    expect(header).toBeDefined();
  });
});

// ─── render.yaml — Content-Security-Policy ───────────────────────────────────

describe('render.yaml — Content-Security-Policy header', () => {
  let cspValue;
  let rawContent;

  beforeAll(() => {
    rawContent = readFile('render.yaml');
    cspValue = getRenderCspValue();
  });

  test('render.yaml exists and is readable', () => {
    expect(fileExists('render.yaml')).toBe(true);
    expect(rawContent.length).toBeGreaterThan(0);
  });

  test('Content-Security-Policy entry is present', () => {
    expect(cspValue).not.toBeNull();
    expect(typeof cspValue).toBe('string');
    expect(cspValue.length).toBeGreaterThan(0);
  });

  // ── Core change: wasm-unsafe-eval removed ──────────────────────────────────

  test('wasm-unsafe-eval is NOT present in CSP value (removed by this PR)', () => {
    expect(cspValue).not.toContain('wasm-unsafe-eval');
  });

  // Also verify it's not lurking elsewhere in the file
  test('wasm-unsafe-eval does not appear anywhere in render.yaml', () => {
    expect(rawContent).not.toContain('wasm-unsafe-eval');
  });

  // ── Required allowlist entries ─────────────────────────────────────────────

  test('https://cdnjs.cloudflare.com IS present in CSP script-src', () => {
    const scriptSrc = cspValue.match(/script-src([^;]+)/);
    expect(scriptSrc).not.toBeNull();
    expect(scriptSrc[1]).toContain('https://cdnjs.cloudflare.com');
  });

  test('https://cdn.jsdelivr.net IS present in CSP script-src', () => {
    const scriptSrc = cspValue.match(/script-src([^;]+)/);
    expect(scriptSrc).not.toBeNull();
    expect(scriptSrc[1]).toContain('https://cdn.jsdelivr.net');
  });

  test("default-src is 'self'", () => {
    expect(cspValue).toContain("default-src 'self'");
  });

  test("script-src contains 'self'", () => {
    expect(cspValue).toContain("script-src 'self'");
  });

  test("script-src contains 'unsafe-inline'", () => {
    const scriptSrc = cspValue.match(/script-src([^;]+)/);
    expect(scriptSrc).not.toBeNull();
    expect(scriptSrc[1]).toContain("'unsafe-inline'");
  });

  test('worker-src allows blob:', () => {
    const workerSrc = cspValue.match(/worker-src([^;]+)/);
    expect(workerSrc).not.toBeNull();
    expect(workerSrc[1]).toContain('blob:');
  });

  test('media-src allows blob:', () => {
    const mediaSrc = cspValue.match(/media-src([^;]+)/);
    expect(mediaSrc).not.toBeNull();
    expect(mediaSrc[1]).toContain('blob:');
  });

  test('connect-src allows data: and blob:', () => {
    const connectSrc = cspValue.match(/connect-src([^;]+)/);
    expect(connectSrc).not.toBeNull();
    expect(connectSrc[1]).toContain('data:');
    expect(connectSrc[1]).toContain('blob:');
  });

  test('img-src allows data: and blob:', () => {
    const imgSrc = cspValue.match(/img-src([^;]+)/);
    expect(imgSrc).not.toBeNull();
    expect(imgSrc[1]).toContain('data:');
    expect(imgSrc[1]).toContain('blob:');
  });

  // ── No duplicate CSP entries (PR removed the duplicate) ───────────────────

  test('Content-Security-Policy header name appears exactly once', () => {
    const occurrences = (rawContent.match(/name:\s*Content-Security-Policy/g) || []).length;
    expect(occurrences).toBe(1);
  });

  test('only one value line follows the Content-Security-Policy name entry', () => {
    // After removing the duplicate in this PR there should be exactly one value line
    // paired with the CSP name. The regex match returns one result for the pair.
    const matches = rawContent.match(/name:\s*Content-Security-Policy\s*\n\s*value:/g) || [];
    expect(matches.length).toBe(1);
  });

  // ── Boundary / negative ────────────────────────────────────────────────────

  test("unsafe-eval is NOT present anywhere in render.yaml CSP", () => {
    expect(cspValue).not.toContain("'unsafe-eval'");
  });

  test('font-src references fonts.gstatic.com', () => {
    const fontSrc = cspValue.match(/font-src([^;]+)/);
    expect(fontSrc).not.toBeNull();
    expect(fontSrc[1]).toContain('https://fonts.gstatic.com');
  });

  test('style-src references fonts.googleapis.com', () => {
    const styleSrc = cspValue.match(/style-src([^;]+)/);
    expect(styleSrc).not.toBeNull();
    expect(styleSrc[1]).toContain('https://fonts.googleapis.com');
  });
});

// ─── .jules/sentinel.md — removed CSP unsafe-eval section ────────────────────

describe('.jules/sentinel.md — CSP hardening section removed', () => {
  let content;

  beforeAll(() => {
    content = readFile('.jules/sentinel.md');
  });

  test('.jules/sentinel.md exists and is readable', () => {
    expect(fileExists('.jules/sentinel.md')).toBe(true);
    expect(content.length).toBeGreaterThan(0);
  });

  // ── Removed section is gone ────────────────────────────────────────────────

  test('the 2026-03-29 CSP unsafe-eval heading is NOT present (section removed)', () => {
    expect(content).not.toContain('2026-03-29 - Harden CSP by removing unsafe-eval');
  });

  test('"Harden CSP by removing unsafe-eval" heading does not appear', () => {
    expect(content).not.toContain('Harden CSP by removing unsafe-eval');
  });

  test('the removed Learning note about CSP unsafe-eval is not present', () => {
    expect(content).not.toContain('CSP headers should be as restrictive as possible');
  });

  test('the removed Prevention note about unsafe-eval audits is not present', () => {
    expect(content).not.toContain("Periodically audit CSP configurations and remove permissive directives");
  });

  // ── Pre-existing content still present ────────────────────────────────────

  test('crypto.getRandomValues dither noise section is still present', () => {
    expect(content).toContain('crypto.getRandomValues');
  });

  test('TPDF dither noise vulnerability entry is retained', () => {
    expect(content).toContain('Math.random()');
  });

  test('chunked randomness buffer pattern learning is retained', () => {
    expect(content).toContain('Uint32Array');
  });

  // ── Boundary / negative ────────────────────────────────────────────────────

  test('file does not reference unsafe-eval as a CSP directive to be removed', () => {
    // The removed section specifically discussed removing unsafe-eval from CSP.
    // After the PR there should be no remaining reference to that practice.
    expect(content).not.toContain("'unsafe-eval'");
  });

  test('file does not contain the old CSP-eval Prevention advice', () => {
    expect(content).not.toContain('unless they are strictly required for core functionality');
  });
});

// ─── Cross-file consistency — vercel.json vs render.yaml ─────────────────────

describe('Cross-file consistency — vercel.json and render.yaml CSP parity', () => {
  let vercelCsp;
  let renderCsp;

  beforeAll(() => {
    vercelCsp = getVercelCspValue();
    renderCsp = getRenderCspValue();
  });

  test('neither config contains wasm-unsafe-eval', () => {
    expect(vercelCsp).not.toContain('wasm-unsafe-eval');
    expect(renderCsp).not.toContain('wasm-unsafe-eval');
  });

  test('both configs include cdnjs.cloudflare.com in script-src', () => {
    expect(vercelCsp).toContain('https://cdnjs.cloudflare.com');
    expect(renderCsp).toContain('https://cdnjs.cloudflare.com');
  });

  test('both configs include cdn.jsdelivr.net in script-src', () => {
    expect(vercelCsp).toContain('https://cdn.jsdelivr.net');
    expect(renderCsp).toContain('https://cdn.jsdelivr.net');
  });

  test("both configs have default-src 'self'", () => {
    expect(vercelCsp).toContain("default-src 'self'");
    expect(renderCsp).toContain("default-src 'self'");
  });

  test('both configs define the same set of CSP directive names', () => {
    function extractDirectiveNames(csp) {
      return (csp.match(/[\w-]+-src/g) || []).sort();
    }
    expect(extractDirectiveNames(vercelCsp)).toEqual(extractDirectiveNames(renderCsp));
  });
});