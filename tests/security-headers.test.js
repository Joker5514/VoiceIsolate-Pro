'use strict';

/**
 * Tests for security header configuration changes in vercel.json and render.yaml.
 *
 * PR scope:
 *  - vercel.json: removed 'wasm-unsafe-eval' from script-src, added cdnjs.cloudflare.com
 *  - render.yaml: removed 'wasm-unsafe-eval' from script-src (also collapsed duplicate CSP line)
 *  - .jules/sentinel.md: removed the 2026-03-29 CSP hardening entry
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function readFile(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

// ─── vercel.json ─────────────────────────────────────────────────────────────

describe('vercel.json — Content-Security-Policy', () => {
  let config;
  let cspValue;

  beforeAll(() => {
    const raw = readFile('vercel.json');
    config = JSON.parse(raw);

    const globalHeaders = config.headers.find(entry => entry.source === '/(.*)');
    expect(globalHeaders).toBeDefined();

    const cspHeader = globalHeaders.headers.find(h => h.key === 'Content-Security-Policy');
    expect(cspHeader).toBeDefined();
    cspValue = cspHeader.value;
  });

  test("'wasm-unsafe-eval' is absent from script-src (removed in this PR)", () => {
    expect(cspValue).not.toContain("'wasm-unsafe-eval'");
  });

  test("'unsafe-eval' is absent from the entire CSP (no eval allowed)", () => {
    expect(cspValue).not.toContain("'unsafe-eval'");
  });

  test('https://cdnjs.cloudflare.com is present in script-src (added in this PR)', () => {
    const scriptSrc = cspValue.match(/script-src ([^;]+)/)?.[1] ?? '';
    expect(scriptSrc).toContain('https://cdnjs.cloudflare.com');
  });

  test("script-src still includes 'self'", () => {
    const scriptSrc = cspValue.match(/script-src ([^;]+)/)?.[1] ?? '';
    expect(scriptSrc).toContain("'self'");
  });

  test("script-src still includes 'unsafe-inline'", () => {
    const scriptSrc = cspValue.match(/script-src ([^;]+)/)?.[1] ?? '';
    expect(scriptSrc).toContain("'unsafe-inline'");
  });

  test('script-src still includes https://cdn.jsdelivr.net', () => {
    const scriptSrc = cspValue.match(/script-src ([^;]+)/)?.[1] ?? '';
    expect(scriptSrc).toContain('https://cdn.jsdelivr.net');
  });

  test('script-src still includes /_vercel path for Vercel internals', () => {
    const scriptSrc = cspValue.match(/script-src ([^;]+)/)?.[1] ?? '';
    expect(scriptSrc).toContain('/_vercel');
  });

  test("default-src is 'self'", () => {
    expect(cspValue).toContain("default-src 'self'");
  });

  test('style-src allows Google Fonts stylesheet', () => {
    const styleSrc = cspValue.match(/style-src ([^;]+)/)?.[1] ?? '';
    expect(styleSrc).toContain('https://fonts.googleapis.com');
  });

  test('font-src allows Google Fonts static assets', () => {
    const fontSrc = cspValue.match(/font-src ([^;]+)/)?.[1] ?? '';
    expect(fontSrc).toContain('https://fonts.gstatic.com');
  });

  test('worker-src allows blob: (required for Web Workers)', () => {
    const workerSrc = cspValue.match(/worker-src ([^;]+)/)?.[1] ?? '';
    expect(workerSrc).toContain('blob:');
  });

  test('media-src allows blob: (required for audio/video processing)', () => {
    const mediaSrc = cspValue.match(/media-src ([^;]+)/)?.[1] ?? '';
    expect(mediaSrc).toContain('blob:');
  });

  test('img-src allows data: and blob: (required for thumbnails and previews)', () => {
    const imgSrc = cspValue.match(/img-src ([^;]+)/)?.[1] ?? '';
    expect(imgSrc).toContain('data:');
    expect(imgSrc).toContain('blob:');
  });
});

describe('vercel.json — file validity and structure', () => {
  test('vercel.json parses as valid JSON without throwing', () => {
    expect(() => JSON.parse(readFile('vercel.json'))).not.toThrow();
  });

  test('vercel.json has exactly one CSP header entry for the global route', () => {
    const config = JSON.parse(readFile('vercel.json'));
    const globalHeaders = config.headers.find(e => e.source === '/(.*)');
    const cspEntries = globalHeaders.headers.filter(h => h.key === 'Content-Security-Policy');
    expect(cspEntries).toHaveLength(1);
  });

  test('vercel.json CSP value is a non-empty string', () => {
    const config = JSON.parse(readFile('vercel.json'));
    const globalHeaders = config.headers.find(e => e.source === '/(.*)');
    const csp = globalHeaders.headers.find(h => h.key === 'Content-Security-Policy');
    expect(typeof csp.value).toBe('string');
    expect(csp.value.length).toBeGreaterThan(0);
  });
});

// ─── render.yaml ─────────────────────────────────────────────────────────────

describe('render.yaml — Content-Security-Policy', () => {
  let renderYaml;
  let cspValue;

  beforeAll(() => {
    renderYaml = readFile('render.yaml');

    // Extract the single CSP value line
    const cspMatch = renderYaml.match(/name:\s*Content-Security-Policy\s*\n\s*value:\s*"([^"]+)"/);
    expect(cspMatch).not.toBeNull();
    cspValue = cspMatch[1];
  });

  test("'wasm-unsafe-eval' is absent from script-src (removed in this PR)", () => {
    expect(cspValue).not.toContain("'wasm-unsafe-eval'");
  });

  test("'unsafe-eval' is absent from the entire CSP (no eval allowed)", () => {
    expect(cspValue).not.toContain("'unsafe-eval'");
  });

  test('https://cdnjs.cloudflare.com is present in script-src', () => {
    const scriptSrc = cspValue.match(/script-src ([^;]+)/)?.[1] ?? '';
    expect(scriptSrc).toContain('https://cdnjs.cloudflare.com');
  });

  test("script-src still includes 'self'", () => {
    const scriptSrc = cspValue.match(/script-src ([^;]+)/)?.[1] ?? '';
    expect(scriptSrc).toContain("'self'");
  });

  test("script-src still includes 'unsafe-inline'", () => {
    const scriptSrc = cspValue.match(/script-src ([^;]+)/)?.[1] ?? '';
    expect(scriptSrc).toContain("'unsafe-inline'");
  });

  test('script-src still includes https://cdn.jsdelivr.net', () => {
    const scriptSrc = cspValue.match(/script-src ([^;]+)/)?.[1] ?? '';
    expect(scriptSrc).toContain('https://cdn.jsdelivr.net');
  });

  test("default-src is 'self'", () => {
    expect(cspValue).toContain("default-src 'self'");
  });

  test('worker-src allows blob: (required for Web Workers)', () => {
    const workerSrc = cspValue.match(/worker-src ([^;]+)/)?.[1] ?? '';
    expect(workerSrc).toContain('blob:');
  });

  test('media-src allows blob: (required for audio/video processing)', () => {
    const mediaSrc = cspValue.match(/media-src ([^;]+)/)?.[1] ?? '';
    expect(mediaSrc).toContain('blob:');
  });
});

describe('render.yaml — no duplicate CSP header entries (collapsed in this PR)', () => {
  test('Content-Security-Policy appears exactly once in render.yaml', () => {
    const renderYaml = readFile('render.yaml');
    const matches = renderYaml.match(/name:\s*Content-Security-Policy/g) ?? [];
    expect(matches).toHaveLength(1);
  });

  test('the CSP value line appears exactly once (no leftover duplicate)', () => {
    const renderYaml = readFile('render.yaml');
    const valueMatches = renderYaml.match(/value:\s*"default-src/g) ?? [];
    expect(valueMatches).toHaveLength(1);
  });
});

// ─── .jules/sentinel.md ───────────────────────────────────────────────────────

describe('.jules/sentinel.md — CSP hardening entry removed', () => {
  let sentinel;

  beforeAll(() => {
    sentinel = readFile('.jules/sentinel.md');
  });

  test('the 2026-03-29 CSP hardening section heading is absent', () => {
    expect(sentinel).not.toContain('2026-03-29 - Harden CSP by removing unsafe-eval');
  });

  test("'unsafe-eval' guidance text from the removed entry is absent", () => {
    // The removed entry specifically discussed 'unsafe-eval' risk; verify it is gone
    expect(sentinel).not.toContain(
      "The Content Security Policy (CSP) header included the `'unsafe-eval'` directive"
    );
  });

  test('the remaining pre-existing entries are still present', () => {
    expect(sentinel).toContain('2026-03-10 - Eliminate innerHTML usage for DOM construction');
    expect(sentinel).toContain('2024-05-24 - Secure PRNG for Dither');
  });

  test('the file is non-empty', () => {
    expect(sentinel.trim().length).toBeGreaterThan(0);
  });

  // Regression: ensure the section was not merely blanked but cleanly removed
  test('no blank section heading remains for the removed date (2026-03-29)', () => {
    expect(sentinel).not.toContain('2026-03-29');
  });
});

// ─── Cross-config consistency ─────────────────────────────────────────────────

describe('Cross-config CSP consistency — vercel.json vs render.yaml', () => {
  let vercelCsp;
  let renderCsp;

  beforeAll(() => {
    const vercelConfig = JSON.parse(readFile('vercel.json'));
    const globalHeaders = vercelConfig.headers.find(e => e.source === '/(.*)');
    vercelCsp = globalHeaders.headers.find(h => h.key === 'Content-Security-Policy').value;

    const renderYaml = readFile('render.yaml');
    const cspMatch = renderYaml.match(/name:\s*Content-Security-Policy\s*\n\s*value:\s*"([^"]+)"/);
    renderCsp = cspMatch[1];
  });

  test("neither config allows 'wasm-unsafe-eval'", () => {
    expect(vercelCsp).not.toContain("'wasm-unsafe-eval'");
    expect(renderCsp).not.toContain("'wasm-unsafe-eval'");
  });

  test("neither config allows 'unsafe-eval'", () => {
    expect(vercelCsp).not.toContain("'unsafe-eval'");
    expect(renderCsp).not.toContain("'unsafe-eval'");
  });

  test('both configs include cdnjs.cloudflare.com in script-src', () => {
    expect(vercelCsp).toContain('https://cdnjs.cloudflare.com');
    expect(renderCsp).toContain('https://cdnjs.cloudflare.com');
  });

  test('both configs include cdn.jsdelivr.net in script-src', () => {
    expect(vercelCsp).toContain('https://cdn.jsdelivr.net');
    expect(renderCsp).toContain('https://cdn.jsdelivr.net');
  });

  test("both configs share the same default-src directive ('self')", () => {
    expect(vercelCsp).toContain("default-src 'self'");
    expect(renderCsp).toContain("default-src 'self'");
  });
});