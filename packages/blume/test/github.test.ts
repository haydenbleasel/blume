import { describe, expect, it } from "bun:test";

import { apiUrl, editBaseUrl, repoUrl } from "../src/core/github.ts";
import type { GithubTarget } from "../src/core/github.ts";

/**
 * A resolved `github` block; `host`/`branch` carry their schema defaults. The
 * schema hands these over already normalized (a bare origin, no trailing
 * slash), so the fixtures here are shaped the way the type can actually carry.
 */
const target = (overrides: Partial<GithubTarget> = {}): GithubTarget => ({
  branch: "main",
  host: "https://github.com",
  owner: "acme",
  repo: "docs",
  ...overrides,
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

  it("maps a github.com subdomain to the public API too", () => {
    // `www.github.com` is a spelling of the public site, not an Enterprise
    // Server; deriving `/api/v3` from it would 404 every card.
    expect(apiUrl(target({ host: "https://www.github.com" }))).toBe(
      "https://api.github.com"
    );
  });

  it("maps a data-residency tenant to its api subdomain", () => {
    expect(apiUrl(target({ host: "https://acme.ghe.com" }))).toBe(
      "https://api.acme.ghe.com"
    );
  });

  it("keeps a non-default port on the api subdomain", () => {
    // The origin carries the port, so the API base must too — otherwise the
    // card queries a different endpoint than the one the links use.
    expect(apiUrl(target({ host: "https://acme.ghe.com:8443" }))).toBe(
      "https://api.acme.ghe.com:8443"
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
          api: "https://ghe.acme.com/api/v3",
          host: "https://acme.com",
        })
      )
    ).toBe("https://ghe.acme.com/api/v3");
  });
});
