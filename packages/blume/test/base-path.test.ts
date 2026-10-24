import { describe, expect, it } from "bun:test";

import {
  isRootRelative,
  joinBase,
  mountBase,
  prefixBase,
  stripBase,
  withTrailingSlash,
} from "../src/components/islands/base-path.ts";

// Astro normalizes deployment.base by its trailingSlash setting (the generated
// config pins "never"; an owned config may not), so BASE_URL may be "/docs" or
// "/docs/". Both must behave alike:
// naive `${base}api/ask` under a bare "/docs" produced /docsapi/ask (404).
describe("island base-path helpers", () => {
  it("guarantees a trailing slash", () => {
    expect(withTrailingSlash("/")).toBe("/");
    expect(withTrailingSlash("/docs")).toBe("/docs/");
    expect(withTrailingSlash("/docs/")).toBe("/docs/");
  });

  it("joins endpoint paths under any base shape", () => {
    expect(joinBase("/", "api/ask")).toBe("/api/ask");
    expect(joinBase("/docs", "api/ask")).toBe("/docs/api/ask");
    expect(joinBase("/docs/", "api/ask")).toBe("/docs/api/ask");
  });

  it("strips the base from a pathname for page grounding", () => {
    expect(stripBase("/", "/guide")).toBe("/guide");
    expect(stripBase("/docs", "/docs/guide")).toBe("/guide");
    expect(stripBase("/docs/", "/docs/guide")).toBe("/guide");
    // The bare base itself is the base-less root.
    expect(stripBase("/docs", "/docs")).toBe("/");
    // Unrelated paths pass through untouched.
    expect(stripBase("/docs", "/other")).toBe("/other");
  });

  it("treats every form a browser resolves to another host as external", () => {
    expect(isRootRelative("/guide")).toBe(true);
    expect(isRootRelative("/")).toBe(true);
    expect(isRootRelative("/a//b")).toBe(true);
    // Browsers drop tabs and newlines and read `\` as `/`, so each of these
    // is `//evil.test`.
    for (const route of [
      "//evil.test",
      "/\\evil.test",
      "/\t/evil.test",
      "/\n\\evil.test",
      "/\r\n/evil.test",
      "https://evil.test",
      "guide",
    ]) {
      expect(isRootRelative(route)).toBe(false);
      expect(prefixBase("/", route)).toBe(route);
      expect(prefixBase("/docs", route)).toBe(route);
      expect(mountBase("/docs", route)).toBe(route);
    }
  });
});
