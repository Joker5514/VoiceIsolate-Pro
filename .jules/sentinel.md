## 2024-05-24 - DOM-based XSS with unescaped `file.name`
**Vulnerability:** Found unescaped user input (like `file.name`) being directly written to `innerHTML` when building UI elements dynamically in `src/js/app.js` (`updateBatchUI` and `addForensicEntry`).
**Learning:** Even simple properties like file names can contain malicious scripts. It's a common oversight to trust file names and metadata directly in the frontend. Using string interpolation with `innerHTML` opens up DOM-based XSS if the data isn't sanitized.
**Prevention:** Always use `textContent` with `document.createElement()` when dynamically adding text to the DOM, or ensure proper HTML escaping if `innerHTML` is strictly necessary.

## 2025-05-15 - Command/Filter Injection in FFmpeg.wasm args
**Vulnerability:** Unsanitized numeric inputs (`trimSilenceDB`, `outputSr`, `outputChannels`) and file extensions derived from `fileName` were interpolated directly into FFmpeg command strings in `src/workers/decode-worker.ts`.
**Learning:** Even in a WASM-sandboxed environment like FFmpeg.wasm, command/filter injection can lead to unexpected behavior, bypass processing limits, or potentially exploit the host if the sandbox has escapes. Numeric inputs should never be trusted as strings.
**Prevention:** Always cast and validate numeric inputs using `Number()` and `Number.isFinite()` before interpolation. Sanitize derived strings like file extensions using strict alphanumeric allowlists (e.g., `/[^a-z0-9]/g`) and length limits.
