## 2024-05-18 - [XSS] innerHTML used to render user input
**Vulnerability:** innerHTML was used to append user-controlled data to the DOM directly (e.g. file names), leading to potential cross-site scripting (XSS) vulnerabilities.
**Learning:** Even internal app UI rendering must escape data. Using textContent or explicit DOM API (document.createElement) inherently avoids the issue as opposed to trying to string-interpolate safely.
**Prevention:** Avoid `innerHTML` whenever dealing with dynamic data. Always use DOM node creation and `textContent` to inject user-provided text safely.
