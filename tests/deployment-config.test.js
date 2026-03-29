/**
 * Tests for deployment configuration changes in this PR:
 *   - vercel.json: removed 'wasm-unsafe-eval' from script-src, added cdnjs.cloudflare.com
 *   - render.yaml:  removed 'wasm-unsafe-eval' from script-src
 *   - .jules/sentinel.md: removed the 2026-03-29 CSP-hardening entry
 *
 * Follows the same file-read + assertion pattern used in android-config.test.js.
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function readFile(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

function fileExists(relPath) {
  return fs.existsSync(path.join(ROOT, relPath));
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Extract the value of a named header from vercel.json.
 * Returns the string value for the first header whose "key" matches `headerName`.
 */
function vercelHeaderValue(headers, headerName) {
  for (const rule of headers) {
    for (const h of rule.headers) {
      if (h.key === headerName) return h.value;
    }
  }
  return null;
}

/**
 * Extract the CSP value from render.yaml without a YAML parser.
 * The file contains exactly one Content-Security-Policy block whose `value:`
 * line holds the full policy on a single line.
 */
function renderYamlCspValue(yamlText) {
  // Find the line that starts with whitespace + "value:" and contains
  // known CSP directives (to distinguish from other value: lines).
  const lines = yamlText.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('value:') && trimmed.includes('default-src')) {
      // Strip leading `value:` and surrounding quotes
      return trimmed.replace(/^value:\s*"?/, '').replace(/"?\s*$/, '');
    }
  }
  return null;
}

// ─── vercel.json ─────────────────────────────────────────────────────────────

describe('vercel.json — file integrity', () => {
  test('file exists', () => {
    expect(fileExists('vercel.json')).toBe(true);
  });

  test('file is valid JSON', () => {
    expect(() => JSON.parse(readFile('vercel.json'))).not.toThrow();
  });

  test('top-level "headers" array is present', () => {
    const cfg = JSON.parse(readFile('vercel.json'));
    expect(Array.isArray(cfg.headers)).toBe(true);
    expect(cfg.headers.length).toBeGreaterThan(0);
  });
});

describe('vercel.json — Content-Security-Policy after PR changes', () => {
  let csp;

  beforeAll(() => {
    const cfg = JSON.parse(readFile('vercel.json'));
    csp = vercelHeaderValue(cfg.headers, 'Content-Security-Policy');
  });

  test('CSP header is present', () => {
    expect(csp).not.toBeNull();
    expect(typeof csp).toBe('string');
    expect(csp.length).toBeGreaterThan(0);
  });

  // ── Core change: wasm-unsafe-eval removed ──────────────────────────────────
  test("'wasm-unsafe-eval' is NOT present in CSP (removed by this PR)", () => {
    expect(csp).not.toContain("'wasm-unsafe-eval'");
  });

  test("'unsafe-eval' is NOT present in CSP in any form", () => {
    expect(csp).not.toMatch(/unsafe-eval/);
  });

  // ── Core change: cdnjs.cloudflare.com added to script-src ─────────────────
  test('script-src allows https://cdnjs.cloudflare.com (added by this PR)', () => {
    const scriptSrc = csp.match(/script-src\s+([^;]+)/)?.[1] ?? '';
    expect(scriptSrc).toContain('https://cdnjs.cloudflare.com');
  });

  // ── Regression: existing trusted sources retained ─────────────────────────
  test("script-src retains 'self'", () => {
    const scriptSrc = csp.match(/script-src\s+([^;]+)/)?.[1] ?? '';
    expect(scriptSrc).toContain("'self'");
  });

  test("script-src retains 'unsafe-inline'", () => {
    const scriptSrc = csp.match(/script-src\s+([^;]+)/)?.[1] ?? '';
    expect(scriptSrc).toContain("'unsafe-inline'");
  });

  test('script-src retains https://cdn.jsdelivr.net', () => {
    const scriptSrc = csp.match(/script-src\s+([^;]+)/)?.[1] ?? '';
    expect(scriptSrc).toContain('https://cdn.jsdelivr.net');
  });

  test("script-src retains /_vercel path for Vercel edge scripts", () => {
    const scriptSrc = csp.match(/script-src\s+([^;]+)/)?.[1] ?? '';
    expect(scriptSrc).toContain('/_vercel');
  });

  // ── Regression: other CSP directives intact ───────────────────────────────
  test("default-src is 'self'", () => {
    expect(csp).toMatch(/default-src\s+'self'/);
  });

  test('style-src allows Google Fonts stylesheets', () => {
    expect(csp).toContain('https://fonts.googleapis.com');
  });

  test('font-src allows Google Fonts static assets', () => {
    expect(csp).toContain('https://fonts.gstatic.com');
  });

  test('worker-src allows blob: (required for Web Workers / AudioWorklets)', () => {
    const workerSrc = csp.match(/worker-src\s+([^;]+)/)?.[1] ?? '';
    expect(workerSrc).toContain('blob:');
  });

  test('media-src allows blob: (required for decoded audio)', () => {
    const mediaSrc = csp.match(/media-src\s+([^;]+)/)?.[1] ?? '';
    expect(mediaSrc).toContain('blob:');
  });

  test('img-src allows data: and blob:', () => {
    const imgSrc = csp.match(/img-src\s+([^;]+)/)?.[1] ?? '';
    expect(imgSrc).toContain('data:');
    expect(imgSrc).toContain('blob:');
  });

  // ── Negative / boundary ───────────────────────────────────────────────────
  test("CSP does not contain 'unsafe-hashes'", () => {
    expect(csp).not.toContain("'unsafe-hashes'");
  });

  test('CSP does not permit wildcard (*) in script-src', () => {
    const scriptSrc = csp.match(/script-src\s+([^;]+)/)?.[1] ?? '';
    // A lone '*' (not part of a URL) would be a major security hole
    expect(scriptSrc).not.toMatch(/(^|\s)\*(\s|;|$)/);
  });
});

describe('vercel.json — other security headers unchanged', () => {
  let headers;

  beforeAll(() => {
    const cfg = JSON.parse(readFile('vercel.json'));
    headers = cfg.headers;
  });

  test('Cross-Origin-Opener-Policy is same-origin', () => {
    expect(vercelHeaderValue(headers, 'Cross-Origin-Opener-Policy')).toBe('same-origin');
  });

  test('Cross-Origin-Embedder-Policy is require-corp', () => {
    expect(vercelHeaderValue(headers, 'Cross-Origin-Embedder-Policy')).toBe('require-corp');
  });

  test('Cross-Origin-Resource-Policy is same-origin', () => {
    expect(vercelHeaderValue(headers, 'Cross-Origin-Resource-Policy')).toBe('same-origin');
  });

  test('X-Content-Type-Options is nosniff', () => {
    expect(vercelHeaderValue(headers, 'X-Content-Type-Options')).toBe('nosniff');
  });

  test('X-Frame-Options is DENY', () => {
    expect(vercelHeaderValue(headers, 'X-Frame-Options')).toBe('DENY');
  });

  test('Referrer-Policy is strict-origin-when-cross-origin', () => {
    expect(vercelHeaderValue(headers, 'Referrer-Policy')).toBe('strict-origin-when-cross-origin');
  });
});

// ─── render.yaml ─────────────────────────────────────────────────────────────

describe('render.yaml — file integrity', () => {
  test('file exists', () => {
    expect(fileExists('render.yaml')).toBe(true);
  });

  test('file is non-empty', () => {
    const content = readFile('render.yaml');
    expect(content.trim().length).toBeGreaterThan(0);
  });

  test('file declares at least one service', () => {
    expect(readFile('render.yaml')).toContain('services:');
  });
});

describe('render.yaml — Content-Security-Policy after PR changes', () => {
  let csp;

  beforeAll(() => {
    csp = renderYamlCspValue(readFile('render.yaml'));
  });

  test('CSP value is extractable from render.yaml', () => {
    expect(csp).not.toBeNull();
    expect(typeof csp).toBe('string');
    expect(csp.length).toBeGreaterThan(0);
  });

  // ── Core change: wasm-unsafe-eval removed ─────────────────────────────────
  test("'wasm-unsafe-eval' is NOT present in CSP (removed by this PR)", () => {
    expect(csp).not.toContain("'wasm-unsafe-eval'");
  });

  test("'unsafe-eval' is NOT present in CSP in any form", () => {
    expect(csp).not.toMatch(/unsafe-eval/);
  });

  // ── Regression: trusted sources retained ──────────────────────────────────
  test("script-src retains 'self'", () => {
    const scriptSrc = csp.match(/script-src\s+([^;]+)/)?.[1] ?? '';
    expect(scriptSrc).toContain("'self'");
  });

  test("script-src retains 'unsafe-inline'", () => {
    const scriptSrc = csp.match(/script-src\s+([^;]+)/)?.[1] ?? '';
    expect(scriptSrc).toContain("'unsafe-inline'");
  });

  test('script-src retains https://cdnjs.cloudflare.com', () => {
    const scriptSrc = csp.match(/script-src\s+([^;]+)/)?.[1] ?? '';
    expect(scriptSrc).toContain('https://cdnjs.cloudflare.com');
  });

  test('script-src retains https://cdn.jsdelivr.net', () => {
    const scriptSrc = csp.match(/script-src\s+([^;]+)/)?.[1] ?? '';
    expect(scriptSrc).toContain('https://cdn.jsdelivr.net');
  });

  test("script-src retains /_vercel/ path", () => {
    const scriptSrc = csp.match(/script-src\s+([^;]+)/)?.[1] ?? '';
    expect(scriptSrc).toContain('/_vercel/');
  });

  // ── Regression: other CSP directives intact ───────────────────────────────
  test("default-src is 'self'", () => {
    expect(csp).toMatch(/default-src\s+'self'/);
  });

  test('worker-src allows blob: (required for Web Workers)', () => {
    const workerSrc = csp.match(/worker-src\s+([^;]+)/)?.[1] ?? '';
    expect(workerSrc).toContain('blob:');
  });

  test('media-src allows blob:', () => {
    const mediaSrc = csp.match(/media-src\s+([^;]+)/)?.[1] ?? '';
    expect(mediaSrc).toContain('blob:');
  });

  test('img-src allows data: and blob:', () => {
    const imgSrc = csp.match(/img-src\s+([^;]+)/)?.[1] ?? '';
    expect(imgSrc).toContain('data:');
    expect(imgSrc).toContain('blob:');
  });

  // ── Negative / boundary ───────────────────────────────────────────────────
  test('render.yaml does not define two separate CSP value: lines (no duplicate from diff)', () => {
    const yamlText = readFile('render.yaml');
    const cspValueLines = yamlText
      .split('\n')
      .filter(l => l.trim().startsWith('value:') && l.includes('default-src'));
    // Before this PR there was a duplicate value: line; after the PR there must be exactly one
    expect(cspValueLines.length).toBe(1);
  });

  test('CSP does not permit wildcard (*) in script-src', () => {
    const scriptSrc = csp.match(/script-src\s+([^;]+)/)?.[1] ?? '';
    expect(scriptSrc).not.toMatch(/(^|\s)\*(\s|;|$)/);
  });
});

describe('render.yaml — other security headers present', () => {
  let yaml;

  beforeAll(() => {
    yaml = readFile('render.yaml');
  });

  test('Cross-Origin-Opener-Policy header is declared', () => {
    expect(yaml).toContain('Cross-Origin-Opener-Policy');
  });

  test('Cross-Origin-Embedder-Policy header is declared', () => {
    expect(yaml).toContain('Cross-Origin-Embedder-Policy');
  });

  test('X-Frame-Options header is declared', () => {
    expect(yaml).toContain('X-Frame-Options');
  });

  test('X-Content-Type-Options header is declared', () => {
    expect(yaml).toContain('X-Content-Type-Options');
  });

  test('Referrer-Policy header is declared', () => {
    expect(yaml).toContain('Referrer-Policy');
  });
});

// ─── .jules/sentinel.md ──────────────────────────────────────────────────────

describe('.jules/sentinel.md — documentation after PR changes', () => {
  let sentinel;

  beforeAll(() => {
    sentinel = readFile('.jules/sentinel.md');
  });

  test('file exists', () => {
    expect(fileExists('.jules/sentinel.md')).toBe(true);
  });

  test('file is non-empty', () => {
    expect(sentinel.trim().length).toBeGreaterThan(0);
  });

  // ── Core change: 2026-03-29 CSP-hardening entry removed ──────────────────
  test('the 2026-03-29 CSP hardening entry has been removed', () => {
    expect(sentinel).not.toContain('2026-03-29');
  });

  test("removed entry text about unsafe-eval XSS risk is gone", () => {
    expect(sentinel).not.toContain(
      "The Content Security Policy (CSP) header included the `'unsafe-eval'` directive"
    );
  });

  // ── Regression: earlier entries still present ────────────────────────────
  test('the 2026-03-10 innerHTML XSS entry is still present', () => {
    expect(sentinel).toContain('2026-03-10');
    expect(sentinel).toContain('innerHTML');
  });

  test('the 2024-05-24 PRNG dither entry is still present', () => {
    expect(sentinel).toContain('2024-05-24');
    expect(sentinel).toContain('Math.random()');
  });

  // ── Boundary: the file should not reference unsafe-eval as allowed ────────
  test("sentinel.md does not describe 'unsafe-eval' as a permitted directive", () => {
    // The removed entry described unsafe-eval as something that was allowed;
    // after removal, no such guidance exists in the file.
    expect(sentinel).not.toContain("included the `'unsafe-eval'` directive");
  });
});