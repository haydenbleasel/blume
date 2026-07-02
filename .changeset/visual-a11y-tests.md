---
"blume": patch
---

Add accessibility and visual-regression coverage to the Playwright suite.
`e2e/a11y.spec.ts` runs axe-core (WCAG 2 A/AA) on the home, docs index, and a
content page, checks the skip link is first in the tab order, verifies dark-mode
color contrast, and renders under reduced motion. `e2e/visual.spec.ts` captures
light/dark screenshot baselines for regression diffing.
