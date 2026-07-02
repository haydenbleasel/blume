import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

import { join } from "pathe";

import {
  acquireDevLock,
  isDevLocked,
  refuseIfDevRunning,
} from "../src/cli/dev-lock.ts";
import { logger } from "../src/cli/log.ts";

const dirs: string[] = [];
const rootDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "blume-lock-"));
  dirs.push(dir);
  return dir;
};
const outDir = async (): Promise<string> => join(await rootDir(), ".blume");

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

describe("dev lock", () => {
  it("reports unlocked when no lock file exists", async () => {
    expect(isDevLocked(await outDir())).toBe(false);
  });

  it("holds the lock while this process is alive, then releases it", async () => {
    const dir = await outDir();
    const release = acquireDevLock(dir);
    // Our own PID is alive, so the lock reads as held.
    expect(isDevLocked(dir)).toBe(true);
    expect(existsSync(join(dir, "dev.lock"))).toBe(true);
    release();
    expect(existsSync(join(dir, "dev.lock"))).toBe(false);
    expect(isDevLocked(dir)).toBe(false);
  });

  it("treats a lock from a dead process as stale", async () => {
    const dir = await outDir();
    // Acquire-and-release just to create the dir, then plant a dead PID.
    acquireDevLock(dir)();
    // PID 2147483647 (2^31-1) is never a live process.
    writeFileSync(join(dir, "dev.lock"), "2147483647");
    expect(isDevLocked(dir)).toBe(false);
  });

  it("only removes its own lock on release", async () => {
    const dir = await outDir();
    const release = acquireDevLock(dir);
    // A newer dev server overwrites the lock with its own PID.
    writeFileSync(join(dir, "dev.lock"), "2147483647");
    release();
    // Release must not clobber the other process's lock.
    expect(existsSync(join(dir, "dev.lock"))).toBe(true);
  });

  it("treats a non-positive or non-integer pid as unlocked", async () => {
    const dir = await outDir();
    // Acquire-and-release just to create the dir, then plant an invalid pid.
    acquireDevLock(dir)();
    writeFileSync(join(dir, "dev.lock"), "0");
    expect(isDevLocked(dir)).toBe(false);
  });

  it("is safe to call the release function twice", async () => {
    const dir = await outDir();
    const release = acquireDevLock(dir);
    release();
    // The second call early-returns without touching the filesystem.
    expect(() => release()).not.toThrow();
  });
});

describe("refuseIfDevRunning", () => {
  it("does nothing when .blume is not locked", async () => {
    const root = await rootDir();
    const exit = spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);
    try {
      expect(() => refuseIfDevRunning(root, "building")).not.toThrow();
      expect(exit).not.toHaveBeenCalled();
    } finally {
      exit.mockRestore();
    }
  });

  it("logs an error and exits when a dev server owns .blume", async () => {
    const root = await rootDir();
    // Hold a live lock (our own pid) on <root>/.blume without releasing it.
    acquireDevLock(join(root, ".blume"));
    const errorSpy = spyOn(logger, "error").mockImplementation((() => {
      // Swallow the diagnostic so the test output stays clean.
    }) as never);
    const exit = spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);
    try {
      expect(() => refuseIfDevRunning(root, "building")).toThrow("exit");
      expect(exit).toHaveBeenCalledWith(1);
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      exit.mockRestore();
      errorSpy.mockRestore();
    }
  });
});
