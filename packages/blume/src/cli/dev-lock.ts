import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";

import { join } from "pathe";

import { resolveRuntimeDir } from "../core/project.ts";
import { logger } from "./log.ts";

/**
 * A best-effort PID lock in the shared `.blume/` runtime dir. `blume dev`
 * regenerates and serves `.blume` continuously, so a concurrent `build`,
 * `eject`, or second `dev` that regenerates or deletes it out from under the
 * running Vite server corrupts the dev session. The lock lets those commands
 * detect a live dev server and refuse — and, because it records the server's
 * port, point the caller (often an agent that just tried to start its own
 * server) at the URL to reuse instead.
 */

export interface DevLockInfo {
  pid: number;
  /** Port the dev server is bound to, when known. */
  port?: number;
}

const lockPath = (outDir: string): string => join(outDir, "dev.lock");

const isValidPid = (pid: unknown): pid is number =>
  typeof pid === "number" && Number.isInteger(pid) && pid > 0;

/**
 * Parse a lock file body. Current locks are JSON (`{"pid":123,"port":3001}`);
 * a bare integer (the pre-port format) still parses as a pid-only lock.
 */
const parseLock = (raw: string): DevLockInfo | null => {
  let data: unknown;
  try {
    data = JSON.parse(raw.trim());
  } catch {
    return null;
  }
  if (isValidPid(data)) {
    return { pid: data };
  }
  if (typeof data === "object" && data !== null) {
    const { pid, port } = data as { pid?: unknown; port?: unknown };
    if (isValidPid(pid)) {
      return typeof port === "number" ? { pid, port } : { pid };
    }
  }
  return null;
};

const isProcessAlive = (pid: number): boolean => {
  try {
    // Signal 0 probes liveness without actually signaling the process.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user — still
    // live, so the lock must hold (only ESRCH proves it's gone).
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * Read the lock on `outDir` held by a live `blume dev`, or null. A lock left
 * by a process that has since exited (stale) is treated as absent.
 */
export const readDevLock = (outDir: string): DevLockInfo | null => {
  const path = lockPath(outDir);
  if (!existsSync(path)) {
    return null;
  }
  const lock = parseLock(readFileSync(path, "utf-8"));
  return lock && isProcessAlive(lock.pid) ? lock : null;
};

/** Whether another live `blume dev` holds the lock on `outDir`. */
export const isDevLocked = (outDir: string): boolean =>
  readDevLock(outDir) !== null;

const lockPayload = (port?: number): string =>
  JSON.stringify({
    pid: process.pid,
    ...(port === undefined ? {} : { port }),
  });

const writeLock = (outDir: string, port?: number): void => {
  writeFileSync(lockPath(outDir), lockPayload(port));
};

/** Thrown when another live `blume dev` already holds the lock. */
export class DevLockHeldError extends Error {
  readonly lock: DevLockInfo;

  constructor(lock: DevLockInfo) {
    super(`A blume dev server (pid ${lock.pid}) already holds the lock.`);
    this.name = "DevLockHeldError";
    this.lock = lock;
  }
}

const ownsLock = (outDir: string): boolean => {
  const path = lockPath(outDir);
  if (!existsSync(path)) {
    return false;
  }
  try {
    return parseLock(readFileSync(path, "utf-8"))?.pid === process.pid;
  } catch {
    return false;
  }
};

/**
 * One atomic claim attempt. Returns `true` when this process wins the `wx`
 * write, `false` when the dir held a stale or our-own leftover lock (now
 * cleared, so the caller should retry). Throws {@link DevLockHeldError} when a
 * live foreign holder owns the dir.
 */
const tryClaimLock = (outDir: string, port?: number): boolean => {
  try {
    writeFileSync(lockPath(outDir), lockPayload(port), { flag: "wx" });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
    const existing = readDevLock(outDir);
    if (existing && existing.pid !== process.pid) {
      throw new DevLockHeldError(existing);
    }
    // Stale or our own leftover: clear it and race for the claim again.
    rmSync(lockPath(outDir), { force: true });
    return false;
  }
};

/**
 * Write the current process's dev lock into `outDir` and return a release
 * function. The claim is atomic (`wx`): two `blume dev` processes racing the
 * same dir can't both pass a check-then-write — the loser gets a
 * {@link DevLockHeldError} naming the live holder. A stale lock (dead pid) or
 * this process's own leftover is cleared and re-claimed. The release only
 * removes the file if it's still ours, so a newer dev server's lock is never
 * clobbered.
 */
export const acquireDevLock = (outDir: string, port?: number): (() => void) => {
  mkdirSync(outDir, { recursive: true });
  while (!tryClaimLock(outDir, port)) {
    // Retry until we win the claim or a live holder makes us throw.
  }
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    try {
      if (ownsLock(outDir)) {
        rmSync(lockPath(outDir), { force: true });
      }
    } catch {
      // Best-effort cleanup; a stale lock is handled by the liveness check.
    }
  };
};

/**
 * Rewrite this process's lock with the port the server actually bound (the
 * lock is acquired before the server starts, and Vite may bump a busy port).
 * A lock owned by another process is left alone.
 */
export const updateDevLockPort = (outDir: string, port: number): void => {
  if (ownsLock(outDir)) {
    writeLock(outDir, port);
  }
};

/** Human-readable location of a locked dev server, e.g. " at http://localhost:3001". */
export const describeDevLock = (lock: DevLockInfo): string =>
  lock.port === undefined ? "" : ` at http://localhost:${lock.port}`;

/**
 * Exit with an error when a live `blume dev` owns the runtime dir under `root`.
 * `action` names the operation being refused (e.g. "building"). `runtimeDir`
 * relocates the checked dir: an isolated verify (`.blume-verify`) targets a dir
 * dev never locks, so it proceeds; a default or `--runtime-dir .blume` run still
 * refuses.
 */
export const refuseIfDevRunning = (
  root: string,
  action: string,
  runtimeDir?: string
): void => {
  const lock = readDevLock(resolveRuntimeDir(root, runtimeDir));
  if (lock) {
    logger.error(
      `A \`blume dev\` server is running${describeDevLock(lock)}; ${action} would corrupt its .blume runtime. Reuse that server, stop it first, or re-run with --isolated to build/verify against .blume-verify without touching it.`
    );
    process.exit(1);
  }
};
