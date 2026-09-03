---
"blume": patch
---

Fix the image lightbox becoming impossible to close after the first in-page navigation. `medium-zoom` injected its stylesheet into `<head>` once, when its module first loaded, and the client router's head swap discarded it on the next navigation; with the transition rule gone, the close animation's `transitionend` never fired, so Escape, a backdrop click, and scrolling all left the zoomed image open (and the `zoom-in` cursor disappeared) until a hard reload. The stylesheet now ships in the layout's page CSS, which the router carries across swaps, and the library loads as its `pure` build with no runtime injection.
