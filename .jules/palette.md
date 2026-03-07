# Palette's Journal

## 2024-03-02 - Initial Learnings
**Learning:** Found several basic accessibility issues in the main App component, specifically missing ARIA labels on icon-only buttons, missing alt text on generic placeholders if there were any, and poorly accessible slider inputs.
**Action:** The focus today will be improving the accessibility and usability of the UI controls, specifically targeting icon-only buttons and range sliders with `aria-label`s, as well as fixing some generic keyboard focus states if possible.

## $(date +%Y-%m-%d) - Interactive Drop Zone Accessibility
**Learning:** Custom interactive elements like file drop zones with `role="button"` require explicit keyboard event handlers (`onKeyDown` for Space/Enter) and visual feedback states (like `isDragging`) to ensure complete accessibility compliance and usability.
**Action:** Always map standard button behaviors (Space/Enter keys) to custom elements acting as buttons and ensure visual state changes are clearly reflected during interactions.
## 2024-03-22 - Accessible Disabled States
**Learning:** Using the native `disabled` attribute on buttons removes them from the tab order, making their tooltips (which explain *why* they are disabled) completely inaccessible to keyboard users.
**Action:** Use `aria-disabled="true"` combined with visual styling (`cursor-not-allowed`, muted colors) instead. This keeps the button focusable so keyboard users can still access the `title` tooltip and understand the UI state.
*Note:* Do not add the word "disabled" to the `aria-label` as `aria-disabled` already communicates this to screen readers. Also, ensure the `onClick` handler explicitly calls `e.preventDefault()` if the element is conceptually disabled, as `aria-disabled` does not prevent native click events.

## 2024-05-18 - Synchronous Range Input Visuals
**Learning:** Using an uncontrolled `<input type="range">` with a static adjacent display value (`<span>`) creates a broken UX where dragging the slider provides zero feedback. Users think the interface is frozen or broken because the displayed number never changes.
**Action:** Always wire up range inputs to a controlled React state object that handles the `onChange` event, and bind both the input `value` and the adjacent numerical display `<span>` to this state to provide real-time, synchronous feedback during interaction.
