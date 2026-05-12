## 2026-05-10 - [Tabs & Icon Buttons Accessibility]
**Learning:** Custom tab structures (like the Visualizations tabs in `index.html`) require explicit `role="tab"`, `aria-controls`, `role="tabpanel"`, and `aria-labelledby` attributes. Active tabs should use `tabindex="0"` while inactive tabs use `tabindex="-1"` for proper keyboard navigation. Icon-only buttons (like `#fullscreenSpectroBtn`) must always have an `aria-label` and `title` to be screen reader and mouse hover friendly.
**Action:** Always check for explicit ARIA roles and labels on custom UI structures and icon-only buttons to ensure they remain accessible to all users.
## 2026-05-12 - Custom Inputs and Keyboard Accessibility
**Learning:** When creating custom toggle switches or sliders by hiding the native input with `opacity: 0`, the browser's default keyboard focus indicators also become invisible. This completely breaks keyboard navigation visibility.
**Action:** Always provide explicit `:focus-visible` rules for the visual sibling elements (e.g., `input:focus-visible + .sw-track`) when hiding native inputs to ensure the element remains accessible to keyboard users.
