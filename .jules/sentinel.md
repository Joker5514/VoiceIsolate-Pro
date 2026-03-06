## 2024-05-24 - DOM-based XSS with unescaped `file.name`
**Vulnerability:** Found unescaped user input (like `file.name`) being directly written to `innerHTML` when building UI elements dynamically in `src/js/app.js` (`updateBatchUI` and `addForensicEntry`).
**Learning:** Even simple properties like file names can contain malicious scripts. It's a common oversight to trust file names and metadata directly in the frontend. Using string interpolation with `innerHTML` opens up DOM-based XSS if the data isn't sanitized.
**Prevention:** Always use `textContent` with `document.createElement()` when dynamically adding text to the DOM, or ensure proper HTML escaping if `innerHTML` is strictly necessary.
## 2024-03-03 - FFmpeg Command and Filtergraph Injection
**Vulnerability:** Untrusted user input via `postMessage` (`fileName`, `outputSr`, `outputChannels`, `trimSilenceDB`) was directly interpolated into arguments passed to `ffmpeg.exec()` in the decode worker.
**Learning:** Even within Web Workers and WebAssembly (ffmpeg.wasm), unsanitized inputs used to build command-line arguments can lead to command injection or filtergraph injection, potentially allowing arbitrary file read/write within the virtual filesystem or causing denial of service.
**Prevention:** Always validate numeric inputs using `Number.isFinite()` and ensure string inputs (like file extensions derived from filenames) are strictly sanitized (e.g., using `.replace(/[^a-z0-9]/g, '')`) before passing them to command-execution APIs.
## 2024-03-06 - XSS Code Injection in Worker Blob URL
**Vulnerability:** Found a critical code injection vulnerability in `createDSPWorkerBlobUrl` within `dispatcher-worker.js`. The worker script dynamically injected a user-supplied `url` into an `importScripts('${url}')` call.
**Learning:** Even internal worker orchestration functions can be vulnerable if they construct code strings using naive string interpolation. An attacker could supply a URL with single quotes to break out and execute arbitrary JavaScript, or use a `data:` URI to execute malicious payloads.
**Prevention:** When dynamically injecting URLs into worker scripts via `importScripts`, strictly validate same-origin constraints using `new URL()` to block `data:` and `blob:` schemes, and safely serialize the URL using `JSON.stringify()` to prevent code injection and string breakout vulnerabilities.

## 2024-03-06 - Math.random() in DSP Hot Loops
**Vulnerability:** Initially flagged `Math.random()` usage in `src/audio/zero-noise-processor.worklet.ts` as cryptographically weak.
**Learning:** Using `Math.random()` in DSP hot loops (e.g., generating "comfort noise") is an intentional, acceptable pattern and NOT a security vulnerability. Replacing it with `crypto.getRandomValues()` creates significant performance and garbage collection regressions.
**Prevention:** Context matters. Security scanners should ignore PRNGs used for audio signal generation instead of cryptographic operations.
