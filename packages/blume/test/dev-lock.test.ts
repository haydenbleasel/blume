import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

import { join } from "pathe";

import {
  acquireDevLock,
  describeDevLock,
  DevLockHeldError,
  isDevLocked,
  readDevLock,
  refuseIfDevRunning,
  updateDevLockPort,
} from "../src/cli/dev-lock.ts";
import { logger } from "../src/cli/log.ts";

/**
 * A `logger.error` replacement that swallows the diagnostic so test output
 * stays clean. Consola's `LogFn` shape requires a `raw` variant; nothing in
 * these tests calls it.
 */
const silentLog = Object.assign(
  (): void => {
    // Swallow the diagnostic.
  },
  {
    raw: (): void => {
      // Unused; present only to satisfy consola's LogFn shape.
    },
  }
);

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

  it("refuses to claim over another live process's lock", async () => {
    const dir = await outDir();
    acquireDevLock(dir)();
    // PID 1 (init/launchd) is always alive and never ours.
    writeFileSync(
      join(dir, "dev.lock"),
      JSON.stringify({ pid: 1, port: 3001 })
    );
    let thrown: unknown;
    try {
      acquireDevLock(dir);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DevLockHeldError);
    // SAFETY: the toBeInstanceOf assertion above has already thrown if
    // `thrown` is anything but a DevLockHeldError.
    expect((thrown as DevLockHeldError).lock).toStrictEqual({
      pid: 1,
      port: 3001,
    });
    // The live holder's lock survives the refused attempt.
    expect(readDevLock(dir)?.pid).toBe(1);
  });

  it("reclaims a stale lock atomically", async () => {
    const dir = await outDir();
    acquireDevLock(dir)();
    // A dead process's leftover must not block a new server.
    writeFileSync(join(dir, "dev.lock"), "2147483647");
    const release = acquireDevLock(dir, 4321);
    expect(readDevLock(dir)?.pid).toBe(process.pid);
    release();
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

  it("records and reads back the dev server port", async () => {
    const dir = await outDir();
    const release = acquireDevLock(dir, 3001);
    expect(readDevLock(dir)).toEqual({ pid: process.pid, port: 3001 });
    release();
  });

  it("reads a lock acquired without a port as pid-only", async () => {
    const dir = await outDir();
    const release = acquireDevLock(dir);
    expect(readDevLock(dir)).toEqual({ pid: process.pid });
    release();
  });

  it("treats a legacy bare-pid lock from a live process as held", async () => {
    const dir = await outDir();
    // Create the dir, then plant the pre-port lock format: a bare pid.
    acquireDevLock(dir)();
    writeFileSync(join(dir, "dev.lock"), String(process.pid));
    expect(readDevLock(dir)).toEqual({ pid: process.pid });
  });

  it("treats an unparseable lock file as unlocked", async () => {
    const dir = await outDir();
    acquireDevLock(dir)();
    writeFileSync(join(dir, "dev.lock"), "not json");
    expect(isDevLocked(dir)).toBe(false);
  });

  it("treats a JSON lock with an invalid pid as unlocked", async () => {
    const dir = await outDir();
    acquireDevLock(dir)();
    writeFileSync(join(dir, "dev.lock"), JSON.stringify({ port: 3001 }));
    expect(isDevLocked(dir)).toBe(false);
  });

  it("updates its own lock with the actually bound port", async () => {
    const dir = await outDir();
    const release = acquireDevLock(dir, 4321);
    // Vite bumped the busy default port; the lock follows the real binding.
    updateDevLockPort(dir, 4322);
    expect(readDevLock(dir)).toEqual({ pid: process.pid, port: 4322 });
    release();
  });

  it("does nothing when updating a port with no lock on disk", async () => {
    const dir = await outDir();
    // Create the dir without leaving a lock behind.
    acquireDevLock(dir)();
    updateDevLockPort(dir, 4322);
    expect(existsSync(join(dir, "dev.lock"))).toBe(false);
  });

  it("never rewrites a lock owned by another process", async () => {
    const dir = await outDir();
    acquireDevLock(dir)();
    writeFileSync(
      join(dir, "dev.lock"),
      JSON.stringify({ pid: 2_147_483_647, port: 3001 })
    );
    updateDevLockPort(dir, 4322);
    expect(JSON.parse(readFileSync(join(dir, "dev.lock"), "utf-8"))).toEqual({
      pid: 2_147_483_647,
      port: 3001,
    });
  });
});

describe("describeDevLock", () => {
  it("formats a URL when the port is known and nothing otherwise", () => {
    expect(describeDevLock({ pid: 1, port: 3001 })).toBe(
      " at http://localhost:3001"
    );
    expect(describeDevLock({ pid: 1 })).toBe("");
  });
});

describe("refuseIfDevRunning", () => {
  it("does nothing when .blume is not locked", async () => {
    const root = await rootDir();
    const exit = spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });
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
    const errorSpy = spyOn(logger, "error").mockImplementation(silentLog);
    const exit = spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });
    try {
      expect(() => refuseIfDevRunning(root, "building")).toThrow("exit");
      expect(exit).toHaveBeenCalledWith(1);
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      exit.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("proceeds for an isolated runtime dir even when .blume is locked", async () => {
    const root = await rootDir();
    // Dev owns <root>/.blume, but an isolated build targets .blume-verify.
    acquireDevLock(join(root, ".blume"));
    const exit = spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });
    try {
      expect(() =>
        refuseIfDevRunning(root, "building", { runtimeDir: ".blume-verify" })
      ).not.toThrow();
      expect(exit).not.toHaveBeenCalled();
    } finally {
      exit.mockRestore();
    }
  });

  it("points the caller at the running server's URL", async () => {
    const root = await rootDir();
    acquireDevLock(join(root, ".blume"), 3001);
    let message = "";
    const record = (text: string): void => {
      message = text;
    };
    const errorSpy = spyOn(logger, "error").mockImplementation(
      Object.assign(record, { raw: record })
    );
    const exit = spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });
    try {
      expect(() => refuseIfDevRunning(root, "building")).toThrow("exit");
      expect(message).toContain("http://localhost:3001");
    } finally {
      exit.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("still refuses when the runtime dir override points back at .blume", async () => {
    const root = await rootDir();
    acquireDevLock(join(root, ".blume"));
    const errorSpy = spyOn(logger, "error").mockImplementation(silentLog);
    const exit = spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });
    try {
      expect(() =>
        refuseIfDevRunning(root, "building", { runtimeDir: ".blume" })
      ).toThrow("exit");
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      exit.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("suggests --isolated only when the caller supports the flag", async () => {
    const root = await rootDir();
    acquireDevLock(join(root, ".blume"));
    let message = "";
    const record = (text: string): void => {
      message = text;
    };
    const errorSpy = spyOn(logger, "error").mockImplementation(
      Object.assign(record, { raw: record })
    );
    const exit = spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });
    try {
      // build/check accept --isolated, so they keep the escape-hatch hint.
      expect(() =>
        refuseIfDevRunning(root, "building", { isolatedHint: true })
      ).toThrow("exit");
      expect(message).toContain("--isolated");

      // eject has no --isolated flag; suggesting it would silently do nothing.
      expect(() => refuseIfDevRunning(root, "ejecting")).toThrow("exit");
      expect(message).not.toContain("--isolated");
      expect(message).toContain("Reuse that server or stop it first.");
    } finally {
      exit.mockRestore();
      errorSpy.mockRestore();
    }
  });
});
