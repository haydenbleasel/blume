import { describe, expect, it } from "bun:test";

import { apiUrl, editBaseUrl, repoSlug, repoUrl } from "../src/core/github.ts";
import type { GithubTarget } from "../src/core/github.ts";

/** A resolved `github` block; `host`/`branch` carry their schema defaults. */
const target = (overrides: Partial<GithubTarget> = {}): GithubTarget => ({
  branch: "main",
  host: "https://github.com",
  owner: "acme",
  repo: "docs",
  ...overrides,
});

describe(repoSlug, () => {
  it("joins owner and repo without an origin", () => {
    expect(repoSlug(target())).toBe("acme/docs");
  });
});

describe(repoUrl, () => {
  it("builds the public URL by default", () => {
    expect(repoUrl(target())).toBe("https://github.com/acme/docs");
  });

  it("builds against an enterprise host", () => {
    expect(repoUrl(target({ host: "https://github.acme.com" }))).toBe(
      "https://github.acme.com/acme/docs"
    );
  });

  it("does not double the separator when the host has a trailing slash", () => {
    expect(repoUrl(target({ host: "https://github.acme.com/" }))).toBe(
      "https://github.acme.com/acme/docs"
    );
  });
});

describe(editBaseUrl, () => {
  it("extends the repo URL with the configured branch", () => {
    expect(editBaseUrl(target({ branch: "trunk" }))).toBe(
      "https://github.com/acme/docs/edit/trunk"
    );
  });

  it("keeps edit links on an enterprise host", () => {
    expect(editBaseUrl(target({ host: "https://github.acme.com" }))).toBe(
      "https://github.acme.com/acme/docs/edit/main"
    );
  });
});

describe(apiUrl, () => {
  it("maps github.com to the public API", () => {
    expect(apiUrl(target())).toBe("https://api.github.com");
  });

  it("maps a data-residency tenant to its api subdomain", () => {
    expect(apiUrl(target({ host: "https://acme.ghe.com" }))).toBe(
      "https://api.acme.ghe.com"
    );
  });

  it("maps any other host to the enterprise server path", () => {
    expect(apiUrl(target({ host: "https://github.acme.com" }))).toBe(
      "https://github.acme.com/api/v3"
    );
  });

  it("prefers an explicit api over the derived one", () => {
    expect(
      apiUrl(
        target({
          api: "https://ghe.acme.com/api/v3/",
          host: "https://acme.com",
        })
      )
    ).toBe("https://ghe.acme.com/api/v3");
  });
});
