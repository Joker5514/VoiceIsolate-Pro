## 2024-05-24 - DOM-based XSS with unescaped `file.name`
**Vulnerability:** Found unescaped user input (like `file.name`) being directly written to `innerHTML` when building UI elements dynamically in `src/js/app.js` (`updateBatchUI` and `addForensicEntry`).
**Learning:** Even simple properties like file names can contain malicious scripts. It's a common oversight to trust file names and metadata directly in the frontend. Using string interpolation with `innerHTML` opens up DOM-based XSS if the data isn't sanitized.
**Prevention:** Always use `textContent` with `document.createElement()` when dynamically adding text to the DOM, or ensure proper HTML escaping if `innerHTML` is strictly necessary.
