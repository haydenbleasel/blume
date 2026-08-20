---
"blume": patch
---

Harden the Try It playground: empty auth inputs no longer send their redaction placeholder as a real credential (the live request goes out anonymous instead), pre-network URL/header errors are reported as themselves rather than as a CORS failure, spec-derived names are escaped before selector interpolation, external proxy URLs that already carry a query string join with `&`, blank required parameters stay visible in samples and sends, and mid-edit invalid JSON renders as a string literal in the JS/Python samples instead of broken syntax. The AsyncAPI composer now connects with an empty payload editor, prefills channel parameters from declared defaults/examples/enums instead of the sampler literal `string`, and degrades a no-example, no-schema payload to `{}` rather than `null`. The built-in CORS proxy allowlist skips templated server URLs, and a proxy with no allowable origin warns at build time.
