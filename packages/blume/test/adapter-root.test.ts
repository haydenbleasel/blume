import { describe, expect, it } from "bun:test";

import type { AstroIntegration } from "astro";

import { withAdapterRoot } from "../src/astro/adapter-root.ts";

type Hooks = AstroIntegration["hooks"];
type SetupHook = NonNullable<Hooks["astro:config:setup"]>;
type DoneHook = NonNullable<Hooks["astro:config:done"]>;

/** The `root` each root-aware hook was handed, in call order. */
interface Seen {
  done?: URL;
  setup?: URL;
}

/**
 * The adapter reads only `config.root` from each hook's options, so a spy needs
 * only that field; the cast narrows the real (large) hook option type down to
 * the slice under test.
 */
const setupSpy = (record: (root: URL) => void): SetupHook =>
  (({ config }: { config: { root: URL } }) => {
    record(config.root);
  }) as unknown as SetupHook;

const doneSpy = (record: (root: URL) => void): DoneHook =>
  (({ config }: { config: { root: URL } }) => {
    record(config.root);
  }) as unknown as DoneHook;

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

const call = async (
  integration: AstroIntegration,
  root: string,
  extra: Record<string, unknown> = {}
): Promise<void> => {
  const options = { config: { root: new URL(root), ...extra } };
  await integration.hooks["astro:config:setup"]?.(
    options as unknown as Parameters<SetupHook>[0]
  );
  await integration.hooks["astro:config:done"]?.(
    options as unknown as Parameters<DoneHook>[0]
  );
};

describe("withAdapterRoot", () => {
  it("overrides root in both hooks that receive a config", async () => {
    const seen: Seen = {};
    const wrapped = withAdapterRoot(spyIntegration(seen), "/proj");

    await call(wrapped, "file:///proj/.blume/");

    // Both hooks see the project root, never the `.blume` runtime Astro roots at.
    expect(seen.setup?.href).toBe("file:///proj/");
    expect(seen.done?.href).toBe("file:///proj/");
  });

  it("always presents root as a directory URL", async () => {
    // nft and `new URL('.vercel/output/', root)` both resolve *relative* to
    // root, so a missing trailing slash would silently drop the last segment.
    const seen: Seen = {};
    const wrapped = withAdapterRoot(spyIntegration(seen), "/proj/");

    await call(wrapped, "file:///proj/.blume/");

    expect(seen.setup?.href).toBe("file:///proj/");
    expect(new URL(".vercel/output/", seen.setup).href).toBe(
      "file:///proj/.vercel/output/"
    );
  });

  it("collapses any run of trailing slashes to a single directory slash", async () => {
    // The trim runs on library-supplied input, so it must stay linear no matter
    // how many trailing slashes arrive — and still yield one clean directory URL.
    const seen: Seen = {};
    const wrapped = withAdapterRoot(spyIntegration(seen), "/proj////");

    await call(wrapped, "file:///proj/.blume/");

    expect(seen.setup?.href).toBe("file:///proj/");
  });

  it("passes the rest of the hook options through untouched", async () => {
    let srcDir: unknown;
    const integration: AstroIntegration = {
      hooks: {
        "astro:config:setup": (({
          config,
        }: {
          config: { root: URL; srcDir?: unknown };
        }) => {
          ({ srcDir } = config);
        }) as unknown as SetupHook,
      },
      name: "spy",
    };

    await call(withAdapterRoot(integration, "/proj"), "file:///proj/.blume/", {
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

    const wrapped = withAdapterRoot(integration, "/proj");

    expect(wrapped.hooks["astro:config:setup"]).toBeUndefined();
    expect(wrapped.hooks["astro:config:done"]).toBeUndefined();
    expect(wrapped.hooks["astro:build:done"]).toBe(noop);
  });

  it("wraps only the hooks the integration defines", async () => {
    const seen: Seen = {};
    const wrapped = withAdapterRoot(
      spyIntegration(seen, ["astro:config:done"]),
      "/proj"
    );

    await call(wrapped, "file:///proj/.blume/");

    expect(wrapped.hooks["astro:config:setup"]).toBeUndefined();
    expect(seen.done?.href).toBe("file:///proj/");
  });

  it("preserves the integration's name", () => {
    expect(withAdapterRoot(spyIntegration({}), "/proj").name).toBe("spy");
  });
});
