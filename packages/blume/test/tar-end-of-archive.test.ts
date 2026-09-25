import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { gunzipSync } from "node:zlib";

import { join } from "pathe";

import { buildTarGz } from "../src/ai/tar.ts";

const root = mkdtempSync(join(tmpdir(), "blume-tar-end-"));

afterAll(async () => {
  await rm(root, { force: true, recursive: true });
});

const BLOCK = 512;
const RECORD = 20 * BLOCK;

/**
 * One file whose header and content blocks end `gap` blocks short of a
 * record boundary — room for `gap` of the two end-of-archive zero blocks
 * before nanotar's record padding would stop.
 */
const archiveEndingShort = (gap: number): Uint8Array =>
  buildTarGz([
    {
      content: new Uint8Array(RECORD - BLOCK - gap * BLOCK).fill(0x61),
      path: "SKILL.md",
    },
  ]);

describe("buildTarGz end-of-archive marker", () => {
  // Zero or one block of room: the archive grows by a record to fit both.
  // Two or more: the record padding already holds them.
  it.each([
    [0, 2 * RECORD],
    [1, 2 * RECORD],
    [2, RECORD],
    [10, RECORD],
  ])(
    "ends with two zero blocks when the entries stop %i block(s) short of a record",
    (gap, size) => {
      const tar = gunzipSync(archiveEndingShort(gap));
      expect(tar.byteLength).toBe(size);
      const used = RECORD - gap * BLOCK;
      expect(tar.subarray(used).every((byte) => byte === 0)).toBe(true);
      expect(tar.byteLength - used).toBeGreaterThanOrEqual(2 * BLOCK);
    }
  );

  // GNU tar warns "A lone zero block at N" on an archive that ends in a single
  // zero block; the in-process checks above hold on every platform.
  it.skipIf(process.platform === "win32").each([0, 1])(
    "extracts an archive %i block(s) short of a record with the system tar, silently",
    async (gap) => {
      const dir = join(root, `gap-${gap}`);
      await mkdir(join(dir, "out"), { recursive: true });
      await writeFile(join(dir, "skill.tar.gz"), archiveEndingShort(gap));
      const result = spawnSync(
        "tar",
        ["-xzf", join(dir, "skill.tar.gz"), "-C", join(dir, "out")],
        { encoding: "utf-8" }
      );
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(readFileSync(join(dir, "out", "SKILL.md")).byteLength).toBe(
        RECORD - BLOCK - gap * BLOCK
      );
    }
  );
});
