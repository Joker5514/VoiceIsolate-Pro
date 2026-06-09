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

## 2026-05-18 - [Custom Modal Keyboard Accessibility & ARIA States Update]
**Learning:** When implementing 'Enter' to submit within custom UI modals, scope the keydown listener to the specific input field (e.g., verifying `e.target.id`) rather than the entire modal document/container to prevent intercepting and hijacking Enter key presses on other interactive elements like buttons.
**Action:** When implementing modal keyboard accessibility, ensure `Enter` key events do not globally override native button click events by strictly limiting the event scope to text inputs.
## 2026-05-18 - [Global Shortcuts vs Custom Component Navigation]
**Learning:** When adding specific keyboard navigation (like Arrow keys for Tabs) to UI components, ensure that global keyboard shortcut handlers (e.g., `_handleGlobalKeydown` in `app.js` or `vip-fixes.js`) are updated to explicitly return/ignore events originating from those components (e.g., `[role="tablist"]`, `BUTTON`) to prevent unintended global actions.
**Action:** When implementing new keyboard shortcuts or interactive keyboard components, double-check that global keydown listeners have explicit scope checks and ignore interactions intended for component-level interaction.
