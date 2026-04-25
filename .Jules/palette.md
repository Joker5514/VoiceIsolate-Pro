## 2024-04-12 - [⚡ Performance Optimization: applyPreset slider loop]
**Learning:** O(n) lookups using document.getElementById for DOM nodes within tight application loops (e.g., applying massive presets) heavily degrade performance.
**Action:** Created `SLIDER_MAP` constant at global level for O(1) attribute lookup, and cached actual DOM references to `this.slidersDom` mapped by element ID during `cacheDom()` to completely eliminate live DOM querying. Performance increased from 5188ms to 58ms.
## 2024-04-14 - [Accessible Tabs]
**Learning:** Custom UI tabs (e.g., `.tab` buttons) must implement explicit ARIA roles (`tablist`, `tab`, `tabpanel`) and dynamically synchronize the `aria-selected` attribute with their active visual state for screen reader accessibility. This includes adding `aria-controls` to the tabs and `aria-labelledby` to the tab panels.
**Action:** When implementing custom tab UI, explicitly set `role="tablist"` on the container, `role="tab"` on the buttons, `role="tabpanel"` on the panels, and sync `aria-selected` in Javascript.
## 2026-04-18 - [⚡ Pipeline loop Performance Optimization]
**Learning:** Using `setTimeout(cb, 8)` to yield the main thread inside a tight loop like an audio processing pipeline adds an excessive artificial delay (e.g. 8ms * 32 stages = 256ms per block/channel).
**Action:** Use `requestAnimationFrame(cb)` (with a fallback to `setTimeout(cb, 0)`) instead of a fixed `setTimeout`. This yields to the browser's paint cycle optimally, allowing UI updates without introducing massive artificial delays during processing tasks.
