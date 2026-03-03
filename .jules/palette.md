# Palette's Journal

## 2024-03-02 - Initial Learnings
**Learning:** Found several basic accessibility issues in the main App component, specifically missing ARIA labels on icon-only buttons, missing alt text on generic placeholders if there were any, and poorly accessible slider inputs.
**Action:** The focus today will be improving the accessibility and usability of the UI controls, specifically targeting icon-only buttons and range sliders with `aria-label`s, as well as fixing some generic keyboard focus states if possible.

## 2024-05-24 - Custom Drop Zone Accessibility & Visual Feedback
**Learning:** Custom drop zones using `role="button"` require explicit visual states (like `isDragging`) and specific keyboard event handlers (`onKeyDown` for Space/Enter) to be fully accessible and intuitive, as they don't inherit these behaviors natively. Users need visual confirmation when hovering files, and screen reader/keyboard users need a way to trigger the action.
**Action:** Always implement `onDragOver`, `onDragLeave`, `onDrop` for visual feedback, and `onKeyDown` for Space/Enter activation when building custom `role="button"` elements.
