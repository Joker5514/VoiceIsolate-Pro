## 2024-05-24 - DOM-based XSS with unescaped `file.name`
**Vulnerability:** Found unescaped user input (like `file.name`) being directly written to `innerHTML` when building UI elements dynamically in `src/js/app.js` (`updateBatchUI` and `addForensicEntry`).
**Learning:** Even simple properties like file names can contain malicious scripts. It's a common oversight to trust file names and metadata directly in the frontend. Using string interpolation with `innerHTML` opens up DOM-based XSS if the data isn't sanitized.
**Prevention:** Always use `textContent` with `document.createElement()` when dynamically adding text to the DOM, or ensure proper HTML escaping if `innerHTML` is strictly necessary.
## 2024-03-03 - FFmpeg Command and Filtergraph Injection
**Vulnerability:** Untrusted user input via `postMessage` (`fileName`, `outputSr`, `outputChannels`, `trimSilenceDB`) was directly interpolated into arguments passed to `ffmpeg.exec()` in the decode worker.
**Learning:** Even within Web Workers and WebAssembly (ffmpeg.wasm), unsanitized inputs used to build command-line arguments can lead to command injection or filtergraph injection, potentially allowing arbitrary file read/write within the virtual filesystem or causing denial of service.
**Prevention:** Always validate numeric inputs using `Number.isFinite()` and ensure string inputs (like file extensions derived from filenames) are strictly sanitized (e.g., using `.replace(/[^a-z0-9]/g, '')`) before passing them to command-execution APIs.
