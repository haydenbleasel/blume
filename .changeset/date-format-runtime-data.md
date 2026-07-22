---
"blume": patch
---

Carry the resolved `dateFormat` config into the runtime data and its `BlumeDataConfig` type. A configured `dateFormat` was silently dropped from the serialized site data, so the date stamps always rendered the default long style, and `blume check` failed with ts(2339) on `data.config.dateFormat` in the generated catch-all page.
