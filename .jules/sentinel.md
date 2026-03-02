## 2024-03-02 - XSS Vulnerability in Batch UI
**Vulnerability:** Found Cross-Site Scripting (XSS) vulnerability in `updateBatchUI` where unsanitized user inputs (`file.name`) were inserted directly into the DOM using `.innerHTML`.
**Learning:** Application UI elements frequently generated from loops iterating over state variables (like lists of user-provided files) are prime targets for XSS if `.innerHTML` is used for rendering without proper escaping.
**Prevention:** Always sanitize dynamically rendered user data via an `escapeHTML` helper or by setting `.textContent` instead of `.innerHTML` when dynamically constructing DOM nodes.
