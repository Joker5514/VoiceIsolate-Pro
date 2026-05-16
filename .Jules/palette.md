## 2026-05-10 - [Tabs & Icon Buttons Accessibility]
**Learning:** Custom tab structures (like the Visualizations tabs in `index.html`) require explicit `role="tab"`, `aria-controls`, `role="tabpanel"`, and `aria-labelledby` attributes. Active tabs should use `tabindex="0"` while inactive tabs use `tabindex="-1"` for proper keyboard navigation. Icon-only buttons (like `#fullscreenSpectroBtn`) must always have an `aria-label` and `title` to be screen reader and mouse hover friendly.
**Action:** Always check for explicit ARIA roles and labels on custom UI structures and icon-only buttons to ensure they remain accessible to all users.
## 2026-05-12 - Custom Inputs and Keyboard Accessibility
**Learning:** When creating custom toggle switches or sliders by hiding the native input with `opacity: 0`, the browser's default keyboard focus indicators also become invisible. This completely breaks keyboard navigation visibility.
**Action:** Always provide explicit `:focus-visible` rules for the visual sibling elements (e.g., `input:focus-visible + .sw-track`) when hiding native inputs to ensure the element remains accessible to keyboard users.

## 2026-05-13 - [Accordion Accessibility & Visual Feedback]
**Learning:** Custom UI accordions (like the slider groups) require semantic ARIA attributes (`aria-expanded`, `aria-controls`) to communicate their state to screen readers, and benefit from visual cues (like an animated chevron arrow) to clarify interactive behavior. Changing DOM classes is not sufficient for accessibility without syncing the corresponding ARIA state.
**Action:** When building or maintaining collapsible panels, always use explicit IDs to link toggles and content with `aria-controls`, synchronize the `aria-expanded` attribute dynamically via JS, and ensure expansion state is visually conveyed (e.g., via CSS transitions on an icon).

## 2026-05-16 - [Custom Modal Accessibility & Keyboard Flow]
**Learning:** Custom modals require explicit ARIA attributes (`role="dialog"`, `aria-modal="true"`, `aria-labelledby`) and dynamic synchronization of `aria-hidden` with their visual state. Furthermore, managing focus when a modal opens (e.g., auto-focusing the first input) and providing keyboard shortcuts (like `Enter` to save and `Escape` to close) are essential for a complete and accessible keyboard flow.
**Action:** Always ensure custom modals implement proper dialog roles, sync `aria-hidden` when toggled, and manage focus and keyboard interactions (Enter/Escape) for full accessibility.
