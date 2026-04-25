## 2024-03-24 - Keyboard Accessibility for Custom Tooltips
**Learning:** Custom tooltips that only respond to mouse events (`mouseenter`/`mouseleave`) inadvertently hide vital contextual information from keyboard-only users who navigate the UI via the `Tab` key.
**Action:** When implementing custom tooltips on interactive elements (like custom sliders), always ensure that the tooltip's visibility logic is also bound to the element's `focus` and `blur` events to guarantee full accessibility.

## 2024-05-24 - Custom Range Inputs Mask Keyboard Focus
**Learning:** When using `-webkit-appearance: none` or `appearance: none` to create custom `<input type="range">` sliders, the browser's default focus ring is often removed (due to `outline: none` being explicitly set to clear native styling artifacts). Without explicitly styling `:focus-visible` on the slider thumb (`::-webkit-slider-thumb` / `::-moz-range-thumb`), keyboard users completely lose track of which slider they are modifying.
**Action:** Always verify keyboard accessibility on custom range inputs, and ensure there is an `outline` or visual indicator specifically tied to `:focus-visible` on both the input itself and the pseudo-element thumb.

## 2024-05-25 - Avoid Stateful ARIA on Static HTML
**Learning:** Adding stateful ARIA attributes (e.g., `aria-selected`, `aria-valuenow`, `role="tab"`) to purely static HTML without corresponding JavaScript logic to dynamically update them creates stale accessibility states. For example, adding `aria-selected="true"` to a static tab means a screen reader will constantly read that the tab is selected regardless of the user's interaction.
**Action:** When enhancing static HTML for accessibility, prefer purely static attributes like `aria-label` or `aria-hidden="true"`. Avoid adding stateful ARIA attributes unless you are also implementing the JavaScript logic to maintain their state accurately.

## 2024-05-26 - CSS Specificity Defeats Global Focus Styles
**Learning:** Global `:focus-visible` rules (specificity 0,1,0) can be silently defeated by element-specific resets like `input[type="range"] { outline: none; }` (specificity 0,1,1). Because of this specificity clash, keyboard users lose the focus ring entirely on critical interactive elements like sliders, rendering them inaccessible.
**Action:** When clearing native outlines on specific elements using selectors with higher specificity, always write a matching or higher-specificity `:focus-visible` rule (e.g., `input[type="range"]:focus-visible`) to ensure the focus ring is explicitly restored.
