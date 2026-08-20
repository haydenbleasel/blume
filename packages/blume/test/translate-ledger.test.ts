import { afterAll, describe, expect, it } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";

import { join } from "pathe";

import {
  emptyLedger,
  hashSource,
  LEDGER_FILE,
  pruneLedger,
  readLedger,
  serializeLedger,
  stampLedger,
  writeLedger,
} from "../src/translate/ledger.ts";
import type { TranslationLedger } from "../src/translate/ledger.ts";

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

const scratch = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "blume-translate-ledger-"));
  dirs.push(dir);
  return dir;
};

describe("hashSource", () => {
  it("is a stable 16-hex-character sha256 prefix", () => {
    const hash = hashSource("---\ntitle: X\n---\n# X\n");
    expect(hash).toMatch(/^[0-9a-f]{16}$/u);
    expect(hashSource("---\ntitle: X\n---\n# X\n")).toBe(hash);
    expect(hashSource("---\ntitle: Y\n---\n# X\n")).not.toBe(hash);
  });
});

describe("readLedger", () => {
  it("round-trips a written ledger", async () => {
    const root = await scratch();
    const ledger = emptyLedger();
    stampLedger(ledger, "docs/a.mdx", "fr", "aaaaaaaaaaaaaaaa");
    stampLedger(ledger, "docs/a.mdx", "de", "bbbbbbbbbbbbbbbb");
    expect(await writeLedger(root, ledger)).toBe(true);
    expect(await readLedger(root)).toStrictEqual({
      files: {
        "docs/a.mdx": { de: "bbbbbbbbbbbbbbbb", fr: "aaaaaaaaaaaaaaaa" },
      },
      version: 1,
    });
  });

  it("tolerates a missing file, bad JSON, and a wrong version", async () => {
    const missing = await scratch();
    expect(await readLedger(missing)).toStrictEqual(emptyLedger());

    const garbage = await scratch();
    await writeFile(join(garbage, LEDGER_FILE), "{not json");
    expect(await readLedger(garbage)).toStrictEqual(emptyLedger());

    const wrongVersion = await scratch();
    await writeFile(
      join(wrongVersion, LEDGER_FILE),
      JSON.stringify({ files: {}, version: 2 })
    );
    expect(await readLedger(wrongVersion)).toStrictEqual(emptyLedger());

    const malformedEntry = await scratch();
    await writeFile(
      join(malformedEntry, LEDGER_FILE),
      JSON.stringify({ files: { "a.mdx": "not-an-object" }, version: 1 })
    );
    expect(await readLedger(malformedEntry)).toStrictEqual(emptyLedger());
  });
});

describe("writeLedger", () => {
  it("serializes deterministically: sorted keys, 2-space indent, trailing newline", async () => {
    const root = await scratch();
    // Stamped in unsorted order on purpose: serialization must sort.
    const unordered = emptyLedger();
    stampLedger(unordered, "docs/b.mdx", "fr", "2222222222222222");
    stampLedger(unordered, "docs/a.mdx", "fr", "1111111111111111");
    stampLedger(unordered, "docs/a.mdx", "de", "3333333333333333");
    const ordered: TranslationLedger = {
      files: {
        "docs/a.mdx": { de: "3333333333333333", fr: "1111111111111111" },
        "docs/b.mdx": { fr: "2222222222222222" },
      },
      version: 1,
    };
    expect(serializeLedger(unordered)).toBe(serializeLedger(ordered));

    await writeLedger(root, unordered);
    const raw = await readFile(join(root, LEDGER_FILE), "utf-8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw.indexOf("docs/a.mdx")).toBeLessThan(raw.indexOf("docs/b.mdx"));
    expect(raw.indexOf('"de"')).toBeLessThan(raw.indexOf('"fr"'));
    expect(raw).toBe(serializeLedger(ordered));
  });

  it("cleans up the temp file when the atomic rename fails", async () => {
    const root = await scratch();
    // A directory squatting on the ledger path makes the rename fail.
    await mkdir(join(root, LEDGER_FILE));
    await expect(writeLedger(root, emptyLedger())).rejects.toThrow();
    const leftovers = await readdir(root);
    expect(leftovers).toEqual([LEDGER_FILE]);
  });

  it("returns false and leaves the file untouched when nothing changed", async () => {
    const root = await scratch();
    const ledger = emptyLedger();
    stampLedger(ledger, "docs/a.mdx", "fr", "1111111111111111");
    expect(await writeLedger(root, ledger)).toBe(true);
    expect(await writeLedger(root, ledger)).toBe(false);

    stampLedger(ledger, "docs/a.mdx", "fr", "2222222222222222");
    expect(await writeLedger(root, ledger)).toBe(true);
  });
});

describe("stampLedger", () => {
  it("adds and overwrites per-locale stamps in place", () => {
    const ledger = emptyLedger();
    stampLedger(ledger, "docs/a.mdx", "fr", "1111111111111111");
    stampLedger(ledger, "docs/a.mdx", "de", "2222222222222222");
    stampLedger(ledger, "docs/a.mdx", "fr", "3333333333333333");
    expect(ledger.files["docs/a.mdx"]).toStrictEqual({
      de: "2222222222222222",
      fr: "3333333333333333",
    });
  });
});

describe("pruneLedger", () => {
  it("drops unknown sources and unconfigured locales, and empty entries", () => {
    const ledger = emptyLedger();
    stampLedger(ledger, "docs/kept.mdx", "fr", "1111111111111111");
    stampLedger(ledger, "docs/kept.mdx", "de", "2222222222222222");
    stampLedger(ledger, "docs/deleted.mdx", "fr", "3333333333333333");
    stampLedger(ledger, "docs/only-de.mdx", "de", "4444444444444444");

    const pruned = pruneLedger(
      ledger,
      new Set(["docs/kept.mdx", "docs/only-de.mdx"]),
      new Set(["fr"])
    );
    expect(pruned).toStrictEqual({
      files: { "docs/kept.mdx": { fr: "1111111111111111" } },
      version: 1,
    });
    // The input ledger is untouched.
    expect(ledger.files["docs/deleted.mdx"]).toBeDefined();
  });
});
