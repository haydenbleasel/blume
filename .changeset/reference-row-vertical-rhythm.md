---
"blume": patch
---

Give a reference row room for what it holds. The row was scaled for a one-line description — 4px between the property name and its description, 8px before the disclosure, 12px of row padding — but a description is a block, so at 4px it sat closer to the label above it than its own paragraphs sat to each other. That inversion is what made a dense reference page read as a wall rather than as rows, and the disclosure below it touched the next row's divider. Every component that draws a reference row now shares one scale: 8px between a row's own lines, 12px before a disclosure, 16px of row padding. Measured on one operation page, the gap between two properties goes from 25px to 33px.

Table cells gain the same treatment for the same reason. At 0.5rem of block padding against a line-height near 1.7, a cell whose content wrapped put more space between its own two lines than between itself and the next row. The inline padding is unchanged on purpose: widening it comes out of column width in a capped article, and on one corpus it pushed cells that fit on two lines onto three, spending the space it had just bought.
