/**
 * The scrollspy's choice of the active "On this page" entry, kept apart from
 * the `<blume-toc>` element (toc-element.ts) so it runs without a DOM.
 */

/** The two measurements the scrollspy takes of a heading. */
export interface MeasuredHeading {
  getBoundingClientRect: () => { top: number };
  getClientRects: () => { length: number };
}

/**
 * The entry for the section being read: the last heading at or above the
 * trigger line (the first heading before any has reached it), or the last
 * heading once the page is scrolled to the bottom.
 *
 * Only rendered headings compete. A heading inside a hidden tab panel
 * (`display: none`) has no boxes and measures `top: 0`, so it would always
 * read as scrolled past and hold the highlight from the top of the page.
 */
export const activeTocEntry = <Entry extends { heading: MeasuredHeading }>(
  entries: readonly Entry[],
  triggerOffset: number,
  scrolledToBottom: boolean
): Entry | null => {
  const rendered = entries.filter(
    ({ heading }) => heading.getClientRects().length > 0
  );
  if (scrolledToBottom) {
    return rendered.at(-1) ?? null;
  }
  // Headings are in document order, so the last one whose top has reached the
  // trigger line is the section currently being read; default to the first.
  let active = rendered[0] ?? null;
  for (const entry of rendered) {
    if (entry.heading.getBoundingClientRect().top <= triggerOffset) {
      active = entry;
    }
  }
  return active;
};
