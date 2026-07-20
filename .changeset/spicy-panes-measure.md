---
"blume": patch
---

Size `<Component>` preview panes to the rendered example instead of the source line count. The generated frame page now observes the example with a ResizeObserver and reports its height to the docs page, which applies it to both the Preview and Code tabs — so short sources that render tall UIs no longer clip, and long sources that render small components no longer float in dead space. The line-count estimate remains the SSR/no-JS initial height (288px floor, 400px ceiling; the measured height is unceilinged up to the viewport), with a height transition so the settle on lazy load doesn't snap. Examples that resize after load keep the pane in sync, and viewport-tracking examples (`h-screen`) can't feed the measurement back into unbounded growth.
