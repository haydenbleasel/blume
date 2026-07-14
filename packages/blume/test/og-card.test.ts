import { describe, expect, it } from "bun:test";

import { renderOgImage } from "../src/og/card.ts";
import type { OgCardOptions } from "../src/og/card.ts";

const expectPng = async (options: OgCardOptions): Promise<void> => {
  const buffer = await renderOgImage(options);
  expect(Buffer.isBuffer(buffer)).toBe(true);
  expect(buffer.length).toBeGreaterThan(0);
};

// A square logo whose viewBox aspect keeps the mark within MARK_MAX_WIDTH, and
// carries `currentColor` so logoMark's foreground repaint runs.
const SQUARE_LOGO =
  '<svg viewBox="0 0 24 24"><path d="M0 0h24v24H0z" fill="currentColor" /></svg>';
// A wide wordmark: 400x40 → computed width 320 > MARK_MAX_WIDTH, forcing the
// down-scale branch.
const WIDE_LOGO =
  '<svg viewBox="0 0 400 40"><rect fill="currentColor" height="40" width="400" /></svg>';
// No viewBox → the aspect match is null and width falls back to MARK_HEIGHT.
const NO_VIEWBOX_LOGO =
  '<svg height="24" width="24"><path d="M0 0h24v24H0z" fill="currentColor" /></svg>';

// 46 chars: past the 40-char threshold but within 60 (titleSize → 64).
const MEDIUM_TITLE = "Documentation for the Blume framework here now";
// Well past 60 chars (titleSize → 52).
const LONG_TITLE =
  "The complete guide to building fast markdown documentation sites with Blume";
// Past 140 chars so truncate trims it inside the body.
const LONG_DESCRIPTION =
  "Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua ut enim ad minim veniam quis nostrud.";

describe("renderOgImage", () => {
  it("renders a minimal card (no logo, brand, description, or footer)", async () => {
    await expectPng({ title: "Hi" });
  });

  it("renders a brand lockup with the accent initial mark", async () => {
    await expectPng({ accent: "purple", brand: "Acme", title: "Short" });
  });

  it("renders an emoji-leading brand without splitting the surrogate pair", async () => {
    // `charAt(0)` used to emit a lone surrogate half, blanking the mark.
    await expectPng({ brand: "🚀 Rocket Docs", title: "Hi" });
  });

  it("renders a square currentColor logo, hex accent, and long description", async () => {
    await expectPng({
      accent: "#123456",
      description: LONG_DESCRIPTION,
      logo: SQUARE_LOGO,
      title: MEDIUM_TITLE,
    });
  });

  it("renders a custom logo and palette", async () => {
    await expectPng({
      brand: "Acme",
      description: "Branded documentation.",
      logo: SQUARE_LOGO,
      palette: {
        accent: "#ff5410",
        background: "#1d1d1d",
        border: "#323232",
        foreground: "#fff6f2",
        muted: "#a6a19f",
      },
      repo: "acme/docs",
      site: "docs.acme.com",
      title: "Getting started",
    });
  });

  it("scales down a wide wordmark logo and a long title", async () => {
    await expectPng({ logo: WIDE_LOGO, title: LONG_TITLE });
  });

  it("renders a logo-only header, ignoring the brand label", async () => {
    // The header is logo only: a wordmark logo already spells the name, and
    // a brand label beside it duplicated it ("Ultracite  Ultracite").
    await expectPng({ brand: "Ultracite", logo: WIDE_LOGO, title: "Hi" });
  });

  it("falls back to MARK_HEIGHT width for a logo without a viewBox", async () => {
    await expectPng({ logo: NO_VIEWBOX_LOGO, title: "Hi" });
  });

  it("renders a footer with only a repo", async () => {
    await expectPng({ repo: "owner/repo", title: "Hi" });
  });

  it("renders a footer with only a site", async () => {
    await expectPng({ site: "docs.acme.com", title: "Hi" });
  });

  it("renders a footer with both repo and site and an unknown accent", async () => {
    await expectPng({
      accent: "chartreuse",
      description: "A short description.",
      repo: "owner/repo",
      site: "docs.acme.com",
      title: "Hi",
    });
  });

  it("falls back on a malformed hex accent instead of crashing Takumi", async () => {
    // "#12345" (5 digits) used to pass straight through and throw a native
    // InvalidArg inside the renderer, failing the whole build at prerender.
    await expectPng({ accent: "#12345", brand: "Acme", title: "Hi" });
    // A prototype member name must not resolve up the chain either.
    await expectPng({ accent: "constructor", brand: "Acme", title: "Hi" });
  });

  it("reads a single-quoted viewBox for the aspect ratio", async () => {
    await expectPng({
      logo: '<svg viewBox=\'0 0 400 40\'><rect fill="currentColor" height="40" width="400" /></svg>',
      title: "Hi",
    });
  });
});
