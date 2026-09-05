---
"blume": patch
---

Scan an `examples.source` directory that lives outside the project root for Tailwind utilities in `<Component />` preview frames, and resolve relative `@source` paths in `theme.css` and `examples.css` from the file that declares them. A monorepo can now point Blume at sibling workspace packages without knowing the generated runtime's directory layout.
