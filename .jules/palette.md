# Palette's Journal

## 2024-03-02 - Initial Learnings
**Learning:** Found several basic accessibility issues in the main App component, specifically missing ARIA labels on icon-only buttons, missing alt text on generic placeholders if there were any, and poorly accessible slider inputs.
**Action:** The focus today will be improving the accessibility and usability of the UI controls, specifically targeting icon-only buttons and range sliders with `aria-label`s, as well as fixing some generic keyboard focus states if possible.

## $(date +%Y-%m-%d) - Interactive Drop Zone Accessibility
**Learning:** Custom interactive elements like file drop zones with `role="button"` require explicit keyboard event handlers (`onKeyDown` for Space/Enter) and visual feedback states (like `isDragging`) to ensure complete accessibility compliance and usability.
**Action:** Always map standard button behaviors (Space/Enter keys) to custom elements acting as buttons and ensure visual state changes are clearly reflected during interactions.
