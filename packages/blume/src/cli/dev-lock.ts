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
 * `eject`, or `sync --force` that regenerates or deletes it out from under the
 * running Vite server corrupts the dev session. The lock lets those commands
 * detect a live dev server and refuse.
 */

const lockPath = (outDir: string): string => join(outDir, "dev.lock");

/**
 * Whether another live `blume dev` holds the lock on `outDir`. A lock left by a
 * process that has since exited (stale) is treated as absent.
 */
export const isDevLocked = (outDir: string): boolean => {
  const path = lockPath(outDir);
  if (!existsSync(path)) {
    return false;
  }
  const pid = Number.parseInt(readFileSync(path, "utf-8").trim(), 10);
  if (!(Number.isInteger(pid) && pid > 0)) {
    return false;
  }
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
 * Write the current process's dev lock into `outDir` and return a release
 * function. The release only removes the file if it's still ours, so a newer
 * dev server's lock is never clobbered.
 */
export const acquireDevLock = (outDir: string): (() => void) => {
  const path = lockPath(outDir);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path, String(process.pid));
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    try {
      if (
        existsSync(path) &&
        readFileSync(path, "utf-8").trim() === String(process.pid)
      ) {
        rmSync(path, { force: true });
      }
    } catch {
      // Best-effort cleanup; a stale lock is handled by the liveness check.
    }
  };
};

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
  if (isDevLocked(resolveRuntimeDir(root, runtimeDir))) {
    logger.error(
      `A \`blume dev\` server is running against .blume; ${action} would corrupt it. Stop the dev server, or re-run with --isolated to build/verify against .blume-verify without touching it.`
    );
    process.exit(1);
  }
};
