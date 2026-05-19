## 2026-05-10 - [Tabs & Icon Buttons Accessibility]
**Learning:** Custom tab structures (like the Visualizations tabs in `index.html`) require explicit `role="tab"`, `aria-controls`, `role="tabpanel"`, and `aria-labelledby` attributes. Active tabs should use `tabindex="0"` while inactive tabs use `tabindex="-1"` for proper keyboard navigation. Icon-only buttons (like `#fullscreenSpectroBtn`) must always have an `aria-label` and `title` to be screen reader and mouse hover friendly.
**Action:** Always check for explicit ARIA roles and labels on custom UI structures and icon-only buttons to ensure they remain accessible to all users.
## 2026-05-12 - Custom Inputs and Keyboard Accessibility
**Learning:** When creating custom toggle switches or sliders by hiding the native input with `opacity: 0`, the browser's default keyboard focus indicators also become invisible. This completely breaks keyboard navigation visibility.
**Action:** Always provide explicit `:focus-visible` rules for the visual sibling elements (e.g., `input:focus-visible + .sw-track`) when hiding native inputs to ensure the element remains accessible to keyboard users.

## 2026-05-13 - [Accordion Accessibility & Visual Feedback]
**Learning:** Custom UI accordions (like the slider groups) require semantic ARIA attributes (`aria-expanded`, `aria-controls`) to communicate their state to screen readers, and benefit from visual cues (like an animated chevron arrow) to clarify interactive behavior. Changing DOM classes is not sufficient for accessibility without syncing the corresponding ARIA state.
**Action:** When building or maintaining collapsible panels, always use explicit IDs to link toggles and content with `aria-controls`, synchronize the `aria-expanded` attribute dynamically via JS, and ensure expansion state is visually conveyed (e.g., via CSS transitions on an icon).

## 2026-05-18 - [Custom Modal Keyboard Accessibility & ARIA States]
**Learning:** Custom UI modals must implement complete keyboard and accessibility flows, including `role="dialog"`, `aria-modal="true"`, `aria-labelledby`, dynamic `aria-hidden` synchronization, auto-focusing the primary input on open, returning focus to the trigger on close, and keydown listeners for Escape (to close) and Enter (to submit).
**Action:** When creating or modifying custom modals, ensure the entire lifecycle of the modal is accessible by syncing the `aria-hidden` state, managing focus effectively on open and close, and supporting keyboard interactions.

## 2026-05-18 - [Toggle Switch Keyboard Accessibility]
**Learning:** Hidden inputs in custom toggle switches using `opacity: 0` lose default browser focus outlines. This renders them invisible to keyboard-only users who navigate via Tab.
**Action:** When hiding inputs to style them, always add explicit `:focus-visible` rules (e.g., `input:focus-visible + .slider`) to draw a custom focus ring, ensuring the element is visible during keyboard navigation.
