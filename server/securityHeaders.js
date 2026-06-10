/**
 * VoiceIsolate Pro — Security Headers Middleware (Layer 0)
 *
 * Single source of truth for every HTTP security header served by the
 * Express dev server. Production (Vercel) mirrors these in vercel.json.
 *
 * Enforced policy:
 *   - Cross-Origin-Opener-Policy: same-origin   (cross-origin isolation)
 *   - Cross-Origin-Embedder-Policy: require-corp
 *   - Strict Content-Security-Policy with NO 'unsafe-inline' scripts
 *   - X-Content-Type-Options: nosniff
 *   - Permissions-Policy denies the microphone — live-mic ingestion is
 *     architecturally forbidden (see CLAUDE.md §1.1)
 *
 * The legacy Engineer Mode shell (public/app/, public/index.html) still
 * contains inline <script> blocks and an inline import map. Until that UI is
 * migrated to src/presentation, those exact paths receive a scoped
 * 'unsafe-inline' script-src exception. New surfaces never get it.
 */
'use strict';

/** Paths still allowed inline scripts during the legacy-UI migration.
 *  The landing page (/) is already inline-free and runs strict CSP. */
const LEGACY_INLINE_PREFIXES = ['/app', '/blueprint', '/docs'];

function isLegacyInlinePath(reqPath) {
  return LEGACY_INLINE_PREFIXES.some(
    (p) => reqPath === p || reqPath.startsWith(`${p}/`)
  );
}

function buildCsp({ allowLegacyInline }) {
  const scriptSrc = allowLegacyInline
    ? "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'"
    : "script-src 'self' 'wasm-unsafe-eval'";
  return [
    "default-src 'self'",
    scriptSrc,
    // Style attribute usage is pervasive in the canvas-driven UI; styles are
    // not a script-execution vector under this script-src.
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "connect-src 'self' data: blob:",
    "worker-src 'self' blob:",
    "wasm-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/**
 * Express middleware factory.
 * @param {object} [options]
 * @param {boolean} [options.legacyInline=true] Honor the scoped legacy
 *   inline-script exception. Set false once public/app is migrated.
 * @returns {import('express').RequestHandler}
 */
export function securityHeaders(options = {}) {
  const { legacyInline = true } = options;

  return function securityHeadersMiddleware(req, res, next) {
    // ── Cross-origin isolation (required for high-resolution timers/WASM threads)
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');

    // ── Hardening
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    // Microphone is DENIED for all origins: live-mic processing is forbidden.
    res.setHeader('Permissions-Policy', 'microphone=(), camera=(), geolocation=()');
    if (process.env.NODE_ENV === 'production') {
      res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
    }

    // ── Content Security Policy
    const allowLegacyInline = legacyInline && isLegacyInlinePath(req.path);
    res.setHeader('Content-Security-Policy', buildCsp({ allowLegacyInline }));

    next();
  };
}

export default securityHeaders;
