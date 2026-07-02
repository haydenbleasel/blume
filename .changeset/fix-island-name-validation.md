---
"blume": patch
---

Skip island files whose name isn't a valid identifier instead of emitting a broken module. A file like `islands/Time-Picker.tsx` starts uppercase but its name is used verbatim as an unquoted object key in the generated island map (`Time-Picker: I0`), which is a syntax error that failed the entire build with no pointer to the offending file. Island names are now validated as full PascalCase identifiers (letters, digits, underscores) and non-conforming files are skipped with a warning, like lowercase names already were.
