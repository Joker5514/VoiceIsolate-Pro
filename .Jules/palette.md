## 2024-03-24 - Keyboard Accessibility for Custom Tooltips
**Learning:** Custom tooltips that only respond to mouse events (`mouseenter`/`mouseleave`) inadvertently hide vital contextual information from keyboard-only users who navigate the UI via the `Tab` key.
**Action:** When implementing custom tooltips on interactive elements (like custom sliders), always ensure that the tooltip's visibility logic is also bound to the element's `focus` and `blur` events to guarantee full accessibility.
