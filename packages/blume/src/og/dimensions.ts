/**
 * Dimensions of a generated OG card, shared by the renderer (`card.ts`) and the
 * layouts that declare them as `og:image:width`/`og:image:height` so a crawler
 * can lay out the card without fetching the PNG first.
 *
 * This lives apart from `card.ts` because that module imports the Takumi native
 * binding at load; a layout importing it would drag the renderer into every
 * page render (and into the prerender/SSR bundles that externalize it).
 */
export const OG_IMAGE_WIDTH = 1200;
export const OG_IMAGE_HEIGHT = 630;
export const OG_IMAGE_TYPE = "image/png";
