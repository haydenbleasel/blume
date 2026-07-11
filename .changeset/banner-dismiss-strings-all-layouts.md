---
"blume": patch
---

The announcement banner rendered by `PageLayout` and `ReferenceLayout` fell back to the English "Dismiss announcement" label even on localized sites — only `RootLayout` passed the UI dictionary through. Both layouts now forward the localized banner strings (`ReferenceLayout` gained the same optional `ui` prop the other layouts have, and the generated Scalar reference page passes the resolved dictionary through).
