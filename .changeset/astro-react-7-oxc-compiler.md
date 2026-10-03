---
"blume": patch
---

Update `@astrojs/react` to 7. Its `babel` option is gone, so the React Compiler now runs on Oxc (`oxc-transform-react`) instead of Babel (`babel-plugin-react-compiler`). It still ships with Blume and stays on by default; `react: { compiler: false }` still turns it off.
