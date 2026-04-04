## 2024-03-24 - Keyboard Accessibility for Custom Tooltips
**Learning:** Custom tooltips that only respond to mouse events (`mouseenter`/`mouseleave`) inadvertently hide vital contextual information from keyboard-only users who navigate the UI via the `Tab` key.
**Action:** When implementing custom tooltips on interactive elements (like custom sliders), always ensure that the tooltip's visibility logic is also bound to the element's `focus` and `blur` events to guarantee full accessibility.
## 2026-04-04 - Use purely static attributes when possible for accessibility improvements
**Learning:** When enhancing static HTML for accessibility, prefer purely static attributes like `aria-hidden="true"` or `aria-label`. Avoid adding stateful ARIA attributes unless you are also implementing the JavaScript logic to maintain their state accurately.
**Action:** Only use static attributes like `aria-hidden` for elements that should always be hidden from screen readers.
