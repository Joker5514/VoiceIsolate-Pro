## 2024-05-18 - Missing Focus Styles for Upload Zone and Tab Buttons
**Learning:** Custom UI interactive elements, specifically the file drop zone (`.upload-zone`) and visualization tabs (`.tab-btn`), are missing explicit `:focus-visible` styles. Because native inputs are hidden or these elements are built using custom `div`/`button` structures, they lose standard browser focus indicators, making keyboard navigation difficult for screen reader and keyboard users despite having standard ARIA roles implemented.
**Action:** Always provide explicit `:focus-visible` styles for custom interactive elements (e.g., custom tabs, drop zones) to ensure keyboard accessibility.

## 2026-07-03 - Add Tooltips to Icon-Only Action Buttons
**Learning:** The dynamic `speaker-ui.js` renders icon-only action buttons (like mute). While these correctly used `aria-label` for screen readers, they lacked the standard HTML `title` attribute, which meant sighted mouse users had no tooltip to explain the button's function.
**Action:** Always ensure that icon-only interactive elements receive both an `aria-label` and a `title` attribute, and that both are dynamically updated together when the button's state changes (e.g., from 'Mute' to 'Unmute').
