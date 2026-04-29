## 2024-05-24 - Secure PRNG for Dither

Replaced `Math.random()` in the dither stage with `crypto.getRandomValues()` to
guarantee cryptographically secure randomness.  The output float is derived by
dividing the unsigned 32-bit integer by `0xFFFFFFFF`, giving a uniform
distribution in [0, 1) with no modulo bias.

## 2026-03-10 - Eliminate innerHTML usage for DOM construction

All dynamic DOM construction now uses `createElement`/`textContent`/
`appendChild`.  No `innerHTML` assignments remain in production paths.
This removes the XSS surface that existed when user-supplied filenames or
metadata were interpolated into markup strings.

## 2026-03-29 - Harden CSP by removing unsafe-eval

Removed `unsafe-eval` from the `script-src` directive in both `vercel.json`
and `server.js`.  `wasm-unsafe-eval` is retained for ONNX Runtime WASM
execution (required by the WebAssembly MVP spec).  Removed `unsafe-eval`
eliminates the last eval-class injection vector; all dynamic code paths now
use `new Function` with sanitised inputs or pre-compiled WASM modules.
