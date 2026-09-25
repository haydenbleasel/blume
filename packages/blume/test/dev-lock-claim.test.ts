import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

import { join } from "pathe";

import {
  acquireDevLock,
  DevLockHeldError,
  readDevLock,
} from "../src/cli/dev-lock.ts";

/**
 * How a claim treats what it finds in the way: a lock still being written, a
 * half-written leftover, this process's own lock, and the reap mutex another
 * process holds (or died holding) while it clears a stale lock. The racing
 * processes themselves are exercised in `dev-lock-race.test.ts`.
 */

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

const outDir = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "blume-lock-claim-"));
  dirs.push(root);
  const dir = join(root, ".blume");
  mkdirSync(dir, { recursive: true });
  return dir;
};

/** Plant `dev.lock` with `content`, last modified `ageMs` ago. */
const plantLock = (dir: string, content: string, ageMs: number): void => {
  const path = join(dir, "dev.lock");
  writeFileSync(path, content);
  const modified = (Date.now() - ageMs) / 1000;
  utimesSync(path, modified, modified);
};

const DEAD = '{"pid":2147483647}';

describe("acquireDevLock", () => {
  it("clears a half-written lock left behind long ago", async () => {
    const dir = await outDir();
    plantLock(dir, "", 60_000);
    const release = acquireDevLock(dir, 3001);
    expect(readDevLock(dir)).toEqual({ pid: process.pid, port: 3001 });
    release();
  });

  it("waits on a lock that is still being written instead of clearing it", async () => {
    const dir = await outDir();
    // Cut off and brand new: another process is mid-write. The claim holds
    // off until the grace period (2 s) runs out 150 ms from now.
    plantLock(dir, '{"pid":', 1850);
    const started = Date.now();
    const release = acquireDevLock(dir);
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
    expect(readDevLock(dir)?.pid).toBe(process.pid);
    release();
  });

  it("takes over its own leftover lock", async () => {
    const dir = await outDir();
    acquireDevLock(dir, 3001);
    const release = acquireDevLock(dir, 3002);
    expect(readDevLock(dir)).toEqual({ pid: process.pid, port: 3002 });
    release();
  });

  it("clears a reap mutex whose holder died mid-reap", async () => {
    const dir = await outDir();
    plantLock(dir, DEAD, 0);
    writeFileSync(join(dir, "dev.lock.reap"), DEAD);
    const release = acquireDevLock(dir);
    expect(readDevLock(dir)?.pid).toBe(process.pid);
    expect(existsSync(join(dir, "dev.lock.reap"))).toBe(false);
    release();
  });

  it("waits while a live process holds the reap mutex", async () => {
    const dir = await outDir();
    const mutex = join(dir, "dev.lock.reap");
    plantLock(dir, DEAD, 0);
    // The parent test runner is alive, so its mutex holds until it's gone.
    writeFileSync(mutex, JSON.stringify({ pid: process.ppid }));
    const reaper = Bun.spawn([
      process.execPath,
      "-e",
      `require("node:fs").rmSync(${JSON.stringify(mutex)})`,
    ]);
    const release = acquireDevLock(dir);
    expect(await reaper.exited).toBe(0);
    expect(readDevLock(dir)?.pid).toBe(process.pid);
    release();
  });

  it("never leaves its staging files behind", async () => {
    const dir = await outDir();
    const release = acquireDevLock(dir);
    let thrown: unknown;
    try {
      // A live holder (this process's parent) refuses the claim.
      plantLock(dir, JSON.stringify({ pid: process.ppid }), 0);
      acquireDevLock(dir);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DevLockHeldError);
    expect(await readdir(dir)).toEqual(["dev.lock"]);
    release();
  });
});

describe("readDevLock", () => {
  it("surfaces an unreadable lock path instead of calling it unlocked", async () => {
    const dir = await outDir();
    mkdirSync(join(dir, "dev.lock"));
    expect(() => readDevLock(dir)).toThrow();
  });
});
