import { describe, expect, it } from "bun:test";

import { resolvePopularIconMarkup } from "../src/search/popular-icon.ts";

const identity = (src: string): string => src;
const prefixDocs = (src: string): string =>
  src.startsWith("/") ? `/docs${src}` : src;

describe("resolvePopularIconMarkup", () => {
  it("returns undefined for a missing or unknown built-in name", () => {
    expect(resolvePopularIconMarkup(undefined, identity)).toBeUndefined();
    expect(
      resolvePopularIconMarkup("not-a-real-icon", identity)
    ).toBeUndefined();
  });

  it("renders a built-in Lucide name as an SVG", () => {
    const markup = resolvePopularIconMarkup("rocket", identity);
    expect(markup).toContain("<svg");
    expect(markup).toContain('width="16"');
    expect(markup).toContain('aria-hidden="true"');
  });

  it("passes inline SVG through", () => {
    const svg = '<svg viewBox="0 0 24 24" class="logo-svg"></svg>';
    expect(resolvePopularIconMarkup(svg, identity)).toBe(svg);
  });

  it("renders an image path as an img, applying withBase", () => {
    expect(resolvePopularIconMarkup("/icons/codemap.svg", prefixDocs)).toBe(
      '<img src="/docs/icons/codemap.svg" width="16" height="16" alt="" aria-hidden="true" class="size-4" />'
    );
  });

  it("escapes quotes in image src attributes", () => {
    expect(
      resolvePopularIconMarkup('/x"onerror="alert(1)".svg', identity)
    ).toContain('src="/x&quot;onerror=&quot;alert(1)&quot;.svg"');
  });
});
