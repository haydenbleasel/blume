---
"blume": patch
---

`<Color.Item>` dual-value swatches now actually switch in dark mode. The dark-mode style targeted a `.dark` class that Blume never sets — dark mode is `data-theme="dark"` on `<html>` — so `value={{ light, dark }}` always rendered the light color. The selector now matches the real dark-mode attribute.
