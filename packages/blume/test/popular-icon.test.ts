import { describe, expect, it } from "bun:test";

import { resolvePopularIconMarkup } from "../src/search/popular-icon.ts";

describe("resolvePopularIconMarkup", () => {
  it("returns undefined for a missing or unknown built-in name", () => {
    expect(resolvePopularIconMarkup()).toBeUndefined();
    expect(resolvePopularIconMarkup("not-a-real-icon")).toBeUndefined();
  });

  it("renders a built-in Lucide name as an SVG", () => {
    const markup = resolvePopularIconMarkup("rocket");
    expect(markup).toContain("<svg");
    expect(markup).toContain('width="16"');
    expect(markup).toContain('aria-hidden="true"');
  });

  it("passes inline SVG through", () => {
    const svg = '  <svg viewBox="0 0 24 24" class="logo-svg"></svg>  ';
    expect(resolvePopularIconMarkup(svg)).toBe(svg.trim());
  });

  it("rejects non-SVG markup (falls through to the file glyph)", () => {
    expect(resolvePopularIconMarkup('<img src="/logo.svg">')).toBeUndefined();
  });

  it("renders an image path as an img, applying the deployment base", () => {
    expect(resolvePopularIconMarkup("/icons/codemap.svg", "/docs")).toBe(
      '<img src="/docs/icons/codemap.svg" width="16" height="16" alt="" aria-hidden="true" class="size-4" />'
    );
  });

  it("escapes quotes in image src attributes", () => {
    expect(resolvePopularIconMarkup('/x"onerror="alert(1)".svg')).toContain(
      'src="/x&quot;onerror=&quot;alert(1)&quot;.svg"'
    );
  });
});
