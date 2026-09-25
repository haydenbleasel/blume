import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
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

/** The mutex a process holds while it clears a stale lock. */
const reapPath = (outDir: string): string => join(outDir, "dev.lock.reap");

/**
 * How long a lock file that doesn't parse counts as one being written right
 * now. Blume creates a lock with its whole content in place (see
 * {@link createExclusive}), but one left empty or cut off — by a crash, or by
 * an older Blume that opened the file before writing it — would otherwise
 * read as stale the instant it appears. Past this age it's debris.
 */
const PARTIAL_LOCK_GRACE_MS = 2000;

/** Pause between claim attempts while another process is mid-claim. */
const RETRY_DELAY_MS = 5;

const pause = (ms: number): void => {
  // A synchronous sleep: the claim is synchronous, and what it waits on is
  // another process, so there's nothing in this one to yield to.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/** Per-process counter that keeps concurrent temp file names apart. */
let tempSequence = 0;

/** A private sibling of `path` to stage a write in. */
const tempPath = (path: string): string => {
  tempSequence += 1;
  return `${path}.${process.pid}.${tempSequence}.tmp`;
};

/**
 * Create `path` holding `payload`, atomically and exclusively. The payload
 * goes to a private temp file first, which is then hard-linked into place:
 * the link fails when `path` exists, exactly like a `wx` open, but the file
 * appears with its whole content — no reader ever sees it empty or half
 * written. Returns false when `path` already exists.
 */
const createExclusive = (path: string, payload: string): boolean => {
  const temp = tempPath(path);
  writeFileSync(temp, payload);
  try {
    linkSync(temp, path);
    return true;
  } catch (error) {
    // SAFETY: `linkSync` failures are errno exceptions.
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
    return false;
  } finally {
    rmSync(temp, { force: true });
  }
};

/** Replace `path` with `payload` in one step, so readers see old or new. */
const replaceFile = (path: string, payload: string): void => {
  const temp = tempPath(path);
  writeFileSync(temp, payload);
  renameSync(temp, path);
};

/** A file's text, or null when it doesn't exist (anymore). */
const readIfExists = (
  path: string
): { raw: string; mtimeMs: number } | null => {
  try {
    const raw = readFileSync(path, "utf-8");
    return { mtimeMs: statSync(path).mtimeMs, raw };
  } catch (error) {
    // SAFETY: `readFileSync`/`statSync` failures are errno exceptions.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    return null;
  }
};

/** What `JSON.parse` can yield for a lock file body. */
type LockFileValue =
  | string
  | number
  | boolean
  | null
  | LockFileValue[]
  | { [key: string]: LockFileValue };

const isValidPid = (pid: LockFileValue | undefined): pid is number =>
  typeof pid === "number" && Number.isInteger(pid) && pid > 0;

const isPortNumber = (port: LockFileValue | undefined): port is number =>
  typeof port === "number";

const isLockRecord = (
  data: LockFileValue
): data is { pid?: LockFileValue; port?: LockFileValue } =>
  typeof data === "object" && data !== null;

/**
 * Parse a lock file body. Current locks are JSON (`{"pid":123,"port":3001}`);
 * a bare integer (the pre-port format) still parses as a pid-only lock.
 */
const parseLock = (raw: string): DevLockInfo | null => {
  let data: LockFileValue;
  try {
    data = JSON.parse(raw.trim());
  } catch {
    return null;
  }
  if (isValidPid(data)) {
    return { pid: data };
  }
  if (isLockRecord(data)) {
    const { pid, port } = data;
    if (isValidPid(pid)) {
      return isPortNumber(port) ? { pid, port } : { pid };
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
    // SAFETY: `process.kill` failures are errno exceptions.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** What the lock file on a dir says, read once. */
type LockState =
  | { kind: "absent" }
  /** Unparseable but brand new: another process is writing it right now. */
  | { kind: "busy" }
  | { kind: "live"; lock: DevLockInfo }
  /** A dead holder's lock, or unparseable debris. */
  | { kind: "stale" };

const inspectLock = (outDir: string): LockState => {
  const file = readIfExists(lockPath(outDir));
  if (!file) {
    return { kind: "absent" };
  }
  const lock = parseLock(file.raw);
  if (!lock) {
    return Date.now() - file.mtimeMs < PARTIAL_LOCK_GRACE_MS
      ? { kind: "busy" }
      : { kind: "stale" };
  }
  return isProcessAlive(lock.pid) ? { kind: "live", lock } : { kind: "stale" };
};

/**
 * Whether this process may clear the lock to claim the dir: a dead holder's
 * lock and debris, or this process's own leftover.
 */
const isClaimable = (state: LockState): boolean =>
  state.kind === "stale" ||
  (state.kind === "live" && state.lock.pid === process.pid);

/**
 * Read the lock on `outDir` held by a live `blume dev`, or null. A lock left
 * by a process that has since exited (stale) is treated as absent.
 */
export const readDevLock = (outDir: string): DevLockInfo | null => {
  const state = inspectLock(outDir);
  return state.kind === "live" ? state.lock : null;
};

/** Whether another live `blume dev` holds the lock on `outDir`. */
export const isDevLocked = (outDir: string): boolean =>
  readDevLock(outDir) !== null;

const lockPayload = (port?: number): string => {
  const info: DevLockInfo = { pid: process.pid };
  if (port !== undefined) {
    info.port = port;
  }
  return JSON.stringify(info);
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
 * Clear a claimable lock without racing anyone else doing the same. Two
 * processes can both read the same stale lock; if each simply deleted the
 * file, the slower one could delete the lock the faster one had claimed in
 * between, and both would win. So removing a lock takes the reap mutex
 * (created the same atomic way), and whoever holds it reads the lock again
 * first: a live lock claimed since is left alone. A mutex whose holder died
 * mid-reap is cleared for the next attempt.
 */
const reapStaleLock = (outDir: string): void => {
  const mutex = reapPath(outDir);
  if (!createExclusive(mutex, lockPayload())) {
    const holder = readIfExists(mutex);
    const pid = holder ? parseLock(holder.raw)?.pid : undefined;
    if (pid !== undefined && pid !== process.pid && isProcessAlive(pid)) {
      pause(RETRY_DELAY_MS);
    } else if (holder) {
      rmSync(mutex, { force: true });
    }
    return;
  }
  try {
    if (isClaimable(inspectLock(outDir))) {
      rmSync(lockPath(outDir), { force: true });
    }
  } finally {
    rmSync(mutex, { force: true });
  }
};

/**
 * Write the current process's dev lock into `outDir` and return a release
 * function. Two `blume dev` processes starting at the same moment can't both
 * win: the lock appears whole and exclusively (a hard link, which fails when
 * the file exists), a lock still being written is waited on rather than read
 * as stale, and a stale lock (dead pid) or this process's own leftover is only
 * cleared under the reap mutex — the loser gets a {@link DevLockHeldError}
 * naming the live holder. The release only removes the file if it's still
 * ours, so a newer dev server's lock is never clobbered.
 */
export const acquireDevLock = (outDir: string, port?: number): (() => void) => {
  mkdirSync(outDir, { recursive: true });
  const payload = lockPayload(port);
  while (!createExclusive(lockPath(outDir), payload)) {
    const state = inspectLock(outDir);
    if (isClaimable(state)) {
      reapStaleLock(outDir);
    } else if (state.kind === "live") {
      throw new DevLockHeldError(state.lock);
    } else if (state.kind === "busy") {
      pause(RETRY_DELAY_MS);
    }
    // "absent": the holder released it just now — race for the claim again.
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
    // Replaced in one step: rewriting in place would leave a moment where a
    // concurrent claim reads an empty lock.
    replaceFile(lockPath(outDir), lockPayload(port));
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
 * refuses. Only commands that actually accept `--isolated` (build, check) should
 * set `isolatedHint`, so the refusal never suggests a flag the command ignores.
 */
export const refuseIfDevRunning = (
  root: string,
  action: string,
  options: { runtimeDir?: string; isolatedHint?: boolean } = {}
): void => {
  const lock = readDevLock(resolveRuntimeDir(root, options.runtimeDir));
  if (lock) {
    const remedies = options.isolatedHint
      ? "Reuse that server, stop it first, or re-run with --isolated to build/verify against .blume-verify without touching it."
      : "Reuse that server or stop it first.";
    logger.error(
      `A \`blume dev\` server is running${describeDevLock(lock)}; ${action} would corrupt its .blume runtime. ${remedies}`
    );
    process.exit(1);
  }
};
