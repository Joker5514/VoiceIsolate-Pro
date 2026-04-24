## 2026-04-24 - Dropzone Keyboard Accessibility
**Learning:** When making non-interactive elements (like `div` dropzones) keyboard-accessible as buttons using `tabindex="0"` and `role="button"`, users expect standard button interactions via keyboard. Without explicit handling, they cannot trigger the dropzone.
**Action:** Always attach an `onKeyDown` (or `keydown`) event listener for "Enter" and "Space" (`e.key === " "`) to trigger the intended action. Explicitly call `e.preventDefault()` within the listener to prevent the Space key from triggering default browser page scrolling.
