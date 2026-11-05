/**
 * VoiceIsolate Pro — Content Security Policy for the vip:// app protocol.
 *
 * The web deployment (vercel.json catch-all) has enforced this policy in
 * production; Electron's custom protocol handler historically set COOP/COEP
 * but no CSP, relying on sam-proxy.cjs hardening alone (CLAUDE.md §9). This
 * module gives the custom protocol the same script discipline as the web.
 *
 * Two policy scopes, mirroring server/securityHeaders.js exactly:
 *  - strict — landing and every new surface (no inline scripts);
 *  - legacy — /app, /blueprint, /docs keep the same temporary, explicitly
 *    scoped 'unsafe-inline' script exception the web grants them (the
 *    Engineer shell still contains inline <script> blocks and an inline
 *    import map). If that exception is ever removed on the web, remove it
 *    here in the same change.
 *
 * Differences from the web CSP, and why:
 *  - no Vercel Blob hosts: Electron serves models from the local build via
 *    same-origin /app/models paths (model-cdn-loader rejects other URLs);
 *  - no Google Fonts origins: fonts are self-hosted under /fonts (VIP-024);
 *  - Firebase/Google auth + Drive origins stay: the desktop shell runs the
 *    same sign-in and Drive import/export flows as the web app;
 *  - 'wasm-unsafe-eval' stays: ONNX Runtime WASM needs it (same as web).
 *
 * Set on every vip:// response (documents, workers, and SVGs can all carry
 * policy; the header is inert for ordinary subresources). `bypassCSP: false`
 * in registerSchemesAsPrivileged makes Chromium enforce it.
 */
'use strict';

const SCRIPT_SRC_STRICT = "script-src 'self' 'wasm-unsafe-eval' https://www.gstatic.com https://apis.google.com https://accounts.google.com";
const SCRIPT_SRC_LEGACY = "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://www.gstatic.com https://apis.google.com https://accounts.google.com";

/** Paths still allowed inline scripts during the legacy-UI migration (web parity). */
const LEGACY_INLINE_PREFIXES = ['/app', '/blueprint', '/docs'];

function isLegacyInlinePath(pathname) {
  return LEGACY_INLINE_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`)
  );
}

/**
 * Normalize a URL pathname for the legacy-scope decision (VIP-025).
 *
 * `new URL()` already resolves literal and %2e dot segments, but it
 * does NOT treat an encoded separator as a separator: the pathname of
 * `vip://app/app/..%2findex.html` is still `/app/..%2findex.html`,
 * which starts with `/app/` and used to earn the legacy exception —
 * while `resolveVipPath` in main.cjs decodes it to `/app/../index.html`
 * and serves the LANDING page. Landing content with `unsafe-inline`
 * is exactly the "exception weakens the main policy" hole this scope
 * must not have. So decode once, then resolve `.`/`..` segments over
 * both `/` and `\` (the packaged app runs on Windows, where `\` is a
 * separator too), and decide the scope from the normalized path —
 * the same file the handler actually serves.
 */
function normalizeScopePath(pathname) {
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    decoded = pathname;
  }
  const parts = [];
  for (const seg of decoded.split(/[\\/]+/)) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return `/${parts.join('/')}`;
}

function buildVipCsp({ allowLegacyInline }) {
  return [
    "default-src 'self'",
    allowLegacyInline ? SCRIPT_SRC_LEGACY : SCRIPT_SRC_STRICT,
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "connect-src 'self' data: blob: https://www.googleapis.com https://content.googleapis.com https://oauth2.googleapis.com https://accounts.google.com https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://firestore.googleapis.com",
    "worker-src 'self' blob: 'wasm-unsafe-eval'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-src https://accounts.google.com https://apis.google.com https://docs.google.com",
    "frame-ancestors 'none'",
  ].join('; ');
}

/** Strict policy (landing / new surfaces). */
const VIP_CSP = buildVipCsp({ allowLegacyInline: false });

/**
 * @param {string} [requestUrl] full vip:// URL — path decides the legacy scope
 * @returns {Readonly<Record<string, string>>} security headers for one vip:// response
 */
function vipSecurityHeaders(requestUrl = '') {
  let pathname = '';
  try {
    pathname = new URL(requestUrl).pathname || '/';
  } catch {
    pathname = '/';
  }
  // Scope from the normalized path — the file actually served — not
  // the raw URL spelling (see normalizeScopePath).
  pathname = normalizeScopePath(pathname);
  return {
    'Content-Security-Policy': buildVipCsp({ allowLegacyInline: isLegacyInlinePath(pathname) }),
    // COOP/COEP required for SharedArrayBuffer (worklets / OLA).
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'X-Content-Type-Options': 'nosniff',
  };
}

module.exports = { VIP_CSP, vipSecurityHeaders, isLegacyInlinePath, buildVipCsp, normalizeScopePath };
