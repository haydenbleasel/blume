import { describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { pathToFileURL } from "node:url";

import type { AstroIntegration } from "astro";
import { join } from "pathe";

import { withAdapterRoot } from "../src/astro/adapter-root.ts";

type Hooks = AstroIntegration["hooks"];
type SetupHook = NonNullable<Hooks["astro:config:setup"]>;
type DoneHook = NonNullable<Hooks["astro:config:done"]>;

/** The `root` each root-aware hook was handed, in call order. */
interface Seen {
  done?: URL;
  setup?: URL;
}

/** A spy hook that records the `root` it was handed. */
const setupSpy =
  (record: (root: URL) => void): SetupHook =>
  ({ config }) => {
    record(config.root);
  };

const doneSpy =
  (record: (root: URL) => void): DoneHook =>
  ({ config }) => {
    record(config.root);
  };

const spyIntegration = (
  seen: Seen,
  hooks: ("astro:config:done" | "astro:config:setup")[] = [
    "astro:config:setup",
    "astro:config:done",
  ]
): AstroIntegration => {
  const integration: AstroIntegration = { hooks: {}, name: "spy" };
  if (hooks.includes("astro:config:setup")) {
    integration.hooks["astro:config:setup"] = setupSpy((root) => {
      seen.setup = root;
    });
  }
  if (hooks.includes("astro:config:done")) {
    integration.hooks["astro:config:done"] = doneSpy((root) => {
      seen.done = root;
    });
  }
  return integration;
};

const noop = (): void => {
  // A hook that reads no config; used to prove non-root-aware hooks pass through.
};

const ADAPTER_ROOT = join(tmpdir(), "blume-adapter-project");
const ADAPTER_ROOT_URL = pathToFileURL(`${ADAPTER_ROOT}${nodePath.sep}`).href;
const RUNTIME_ROOT_URL = new URL(".blume/", ADAPTER_ROOT_URL).href;

const call = async (
  integration: AstroIntegration,
  root: string,
  extra: { srcDir?: URL | string } = {}
): Promise<void> => {
  const options = { config: { root: new URL(root), ...extra } };
  // SAFETY: withAdapterRoot's wrapped hooks read only `config.root` from their
  // options and pass the rest of the object through untouched, so this narrow
  // stand-in exercises them fully.
  await integration.hooks["astro:config:setup"]?.(
    options as Parameters<SetupHook>[0]
  );
  // SAFETY: same as above — only `config.root` is read.
  await integration.hooks["astro:config:done"]?.(
    options as Parameters<DoneHook>[0]
  );
};

describe("withAdapterRoot", () => {
  it("overrides root in both hooks that receive a config", async () => {
    const seen: Seen = {};
    const wrapped = withAdapterRoot(spyIntegration(seen), ADAPTER_ROOT);

    await call(wrapped, RUNTIME_ROOT_URL);

    // Both hooks see the project root, never the `.blume` runtime Astro roots at.
    expect(seen.setup?.href).toBe(ADAPTER_ROOT_URL);
    expect(seen.done?.href).toBe(ADAPTER_ROOT_URL);
  });

  it("always presents root as a directory URL", async () => {
    // nft and `new URL('.vercel/output/', root)` both resolve *relative* to
    // root, so a missing trailing slash would silently drop the last segment.
    const seen: Seen = {};
    const wrapped = withAdapterRoot(
      spyIntegration(seen),
      `${ADAPTER_ROOT}${nodePath.sep}`
    );

    await call(wrapped, RUNTIME_ROOT_URL);

    expect(seen.setup?.href).toBe(ADAPTER_ROOT_URL);
    expect(new URL(".vercel/output/", seen.setup).href).toBe(
      new URL(".vercel/output/", ADAPTER_ROOT_URL).href
    );
  });

  it("collapses any run of trailing slashes to a single directory slash", async () => {
    // Normalization runs on library-supplied input, so it must stay linear no
    // matter how many trailing separators arrive — and still yield one clean
    // directory URL.
    const seen: Seen = {};
    const wrapped = withAdapterRoot(
      spyIntegration(seen),
      `${ADAPTER_ROOT}${nodePath.sep}${nodePath.sep}${nodePath.sep}${nodePath.sep}`
    );

    await call(wrapped, RUNTIME_ROOT_URL);

    expect(seen.setup?.href).toBe(ADAPTER_ROOT_URL);
  });

  it("passes the rest of the hook options through untouched", async () => {
    let srcDir: unknown;
    const integration: AstroIntegration = {
      hooks: {
        "astro:config:setup": ({ config }) => {
          ({ srcDir } = config);
        },
      },
      name: "spy",
    };

    await call(withAdapterRoot(integration, ADAPTER_ROOT), RUNTIME_ROOT_URL, {
      srcDir: "/proj/.blume/src",
    });

    // Only `root` is rewritten — srcDir still points into the runtime, where the
    // generated source actually lives.
    expect(srcDir).toBe("/proj/.blume/src");
  });

  it("leaves an integration without root-aware hooks alone", () => {
    const integration: AstroIntegration = {
      hooks: { "astro:build:done": noop },
      name: "spy",
    };

    const wrapped = withAdapterRoot(integration, ADAPTER_ROOT);

    expect(wrapped.hooks["astro:config:setup"]).toBeUndefined();
    expect(wrapped.hooks["astro:config:done"]).toBeUndefined();
    expect(wrapped.hooks["astro:build:done"]).toBe(noop);
  });

  it("wraps only the hooks the integration defines", async () => {
    const seen: Seen = {};
    const wrapped = withAdapterRoot(
      spyIntegration(seen, ["astro:config:done"]),
      ADAPTER_ROOT
    );

    await call(wrapped, RUNTIME_ROOT_URL);

    expect(wrapped.hooks["astro:config:setup"]).toBeUndefined();
    expect(seen.done?.href).toBe(ADAPTER_ROOT_URL);
  });

  it("preserves the integration's name", () => {
    expect(withAdapterRoot(spyIntegration({}), ADAPTER_ROOT).name).toBe("spy");
  });
});
