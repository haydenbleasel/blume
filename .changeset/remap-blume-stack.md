---
"blume": patch
---

Error reports now relativize `.blume/` stack frames. A frame pointing into the
hidden generated runtime is shortened from its machine-absolute path to a
project-relative `.blume/…` path tagged `(generated)`, so internal-error stacks
stay readable and the user-source frames (custom pages, island/override
wrappers, which keep their real paths) stand out.
