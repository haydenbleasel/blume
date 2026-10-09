// A customer story's Open Graph card, cobranded like its panel: the story
// fill on the left (the customer's color, deepening toward the top-left under
// the faint bloom-dot lattice, see story.css) carries the Blume and customer
// wordmarks, the two-tone headline, and the two headline numbers; the story's
// photo runs flush down the right. Rendered at build by story-card.jpg.ts,
// which the `storyCards` integration in blume.config.ts mounts at
// /customers/og/<id>.jpg; StoryPage points the page's og:image there.
import { readFile } from "node:fs/promises";
import path from "node:path";

import { render } from "takumi-js";
import { container, image, text } from "takumi-js/helpers";
import type { Node } from "takumi-js/helpers";

import type { CustomerStory } from "./customers.ts";

const CARD_WIDTH = 1200;
const CARD_HEIGHT = 630;

const PANEL_WIDTH = 600;
const PADDING = 60;

// story.css's lattice: one hex cell of white dots (bloom.css's --bloom-dots,
// at 1.5x so it survives the card being shown small), faded out from the
// top-left toward the photo.
const LATTICE = `<svg xmlns="http://www.w3.org/2000/svg" width="${PANEL_WIDTH}" height="${CARD_HEIGHT}"><defs><pattern id="d" width="21" height="36.375" patternUnits="userSpaceOnUse"><g fill="#fff"><circle cx="0" cy="0" r="1.65"/><circle cx="21" cy="0" r="1.65"/><circle cx="10.5" cy="18.19" r="1.65"/><circle cx="0" cy="36.375" r="1.65"/><circle cx="21" cy="36.375" r="1.65"/></g></pattern><radialGradient id="f" cx="0.15" cy="0.4" r="1" gradientTransform="translate(0.15 0.4) scale(0.6 0.9) translate(-0.15 -0.4)"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#000"/></radialGradient><mask id="m"><rect width="100%" height="100%" fill="url(#f)"/></mask></defs><rect width="100%" height="100%" fill="url(#d)" mask="url(#m)" opacity="0.14"/></svg>`;

const svgSource = (svg: string): string =>
  `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;

// A single-color SVG from public/, its `currentColor` painted white.
const whiteSvg = async (publicDir: string, src: string): Promise<string> => {
  const svg = await readFile(path.join(publicDir, src), "utf-8");
  return svgSource(svg.replaceAll("currentColor", "#fff"));
};

// The area a customer's wordmark covers beside Blume's: a 5:1 wordmark
// stands 30px tall, a squarer one taller and a wider one shorter, so each
// carries about the same weight.
const WORDMARK_AREA = 30 * 30 * 5;

// A wordmark from public/logos/, drawn white.
const wordmark = async (
  story: CustomerStory,
  publicDir: string
): Promise<Node> => {
  const { logo } = story.customer;
  const height = Math.sqrt((WORDMARK_AREA * logo.height) / logo.width);
  return image({
    height: Math.round(height),
    src: await whiteSvg(publicDir, logo.src),
    width: Math.round((height * logo.width) / logo.height),
  });
};

/** Render `story`'s 1200x630 card to a JPEG, which keeps the photo small. */
export const renderStoryCard = async (
  story: CustomerStory,
  publicDir: string
): Promise<Uint8Array> => {
  const photo = await readFile(path.join(publicDir, story.image.src));
  const photoType = path.extname(story.image.src).slice(1);

  const lockup = container({
    children: [
      // The Blume lockup in the launch video's proportions
      // (packages/video/src/scenes/blume-logo.tsx): Geist SemiBold beside
      // the mark at 0.78 of the type size, a fifth of it apart.
      image({
        height: 28,
        src: await whiteSvg(publicDir, "/logo.svg"),
        width: 25,
      }),
      text("Blume", {
        color: "#fff",
        fontSize: 36,
        fontWeight: 600,
        letterSpacing: "-0.04em",
        lineHeight: 1,
        marginLeft: 7,
      }),
      text("×", {
        color: "rgb(255 255 255 / 0.5)",
        fontSize: 30,
        lineHeight: 1,
        marginLeft: 22,
        marginRight: 22,
      }),
      await wordmark(story, publicDir),
    ],
    style: { alignItems: "center", display: "flex" },
  });

  const headline = container({
    children: [
      text(`${story.title} `, { color: "#fff" }),
      text(story.tagline, { color: "rgb(255 255 255 / 0.65)" }),
    ],
    style: {
      display: "block",
      fontSize: 50,
      fontWeight: 500,
      letterSpacing: "-0.03em",
      lineHeight: 1.1,
      textWrap: "balance",
    },
  });

  const stats = container({
    children: story.stats.map((stat) =>
      container({
        children: [
          text(stat.value, {
            color: "#fff",
            fontSize: 52,
            fontWeight: 500,
            letterSpacing: "-0.05em",
            lineHeight: 1,
          }),
          text(stat.label, {
            color: "rgb(255 255 255 / 0.8)",
            fontSize: 18,
            lineHeight: 1.3,
            marginTop: 10,
            textWrap: "balance",
          }),
        ],
        style: { display: "flex", flex: 1, flexDirection: "column" },
      })
    ),
    style: { display: "flex", gap: 32 },
  });

  const panel = container({
    children: [
      image({
        height: CARD_HEIGHT,
        src: svgSource(LATTICE),
        style: { left: 0, position: "absolute", top: 0 },
        width: PANEL_WIDTH,
      }),
      lockup,
      container({
        children: [headline, stats],
        style: { display: "flex", flexDirection: "column", gap: 44 },
      }),
    ],
    style: {
      backgroundColor: story.color,
      backgroundImage: `linear-gradient(120deg, color-mix(in oklab, ${story.color}, black 30%) 0%, transparent 70%)`,
      display: "flex",
      flexDirection: "column",
      height: CARD_HEIGHT,
      justifyContent: "space-between",
      padding: PADDING,
      position: "relative",
      width: PANEL_WIDTH,
    },
  });

  const node = container({
    children: [
      panel,
      image({
        height: CARD_HEIGHT,
        src: `data:image/${photoType};base64,${photo.toString("base64")}`,
        style: { objectFit: "cover" },
        width: CARD_WIDTH - PANEL_WIDTH,
      }),
    ],
    style: {
      display: "flex",
      height: CARD_HEIGHT,
      width: CARD_WIDTH,
    },
  });

  return render(node, {
    format: "jpeg",
    height: CARD_HEIGHT,
    quality: 90,
    width: CARD_WIDTH,
  });
};
