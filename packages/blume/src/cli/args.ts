import picomatch from "picomatch";

import { logger } from "./log.ts";

const MAX_PORT = 65_535;

/**
 * Parse a `--port` value into a valid port number, or `undefined` when unset.
 * A non-integer or out-of-range value (`--port abc` → `NaN`) exits with an
 * error rather than propagating `localhost:NaN` into the dev server and the
 * `deployment.site` fallback.
 */
export const parsePort = (value?: string): number | undefined => {
  if (value === undefined) {
    return;
  }
  const port = Number(value);
  if (!(Number.isInteger(port) && port >= 1 && port <= MAX_PORT)) {
    logger.error(
      `Invalid --port "${value}" (expected an integer 1-${MAX_PORT}).`
    );
    process.exit(1);
  }
  return port;
};

/**
 * Every value a repeatable string flag was given (`--ignore a --ignore b`), in
 * order. citty 0.2 parses with `node:util.parseArgs` without its `multiple`
 * option, so the parsed `args` keep only the last value; this reads the raw
 * arguments the way that parser does instead: `--name=value`, or `--name`
 * followed by the next token whatever it looks like (`""` when there is
 * none), and nothing after a bare `--`.
 */
export const repeatedFlag = (
  rawArgs: readonly string[],
  name: string
): string[] => {
  const flag = `--${name}`;
  const values: string[] = [];
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (arg === "--") {
      break;
    }
    if (arg === flag) {
      values.push(rawArgs[index + 1] ?? "");
      index += 1;
    } else if (arg?.startsWith(`${flag}=`)) {
      values.push(arg.slice(flag.length + 1));
    }
  }
  return values;
};

/**
 * The `--ignore` globs of `blume validate` and `blume audit`, as a test for
 * the external URLs they skip: any glob matching the full URL skips it, with
 * `dot` set so `**` also crosses a segment like `/.well-known/`. No globs skip
 * nothing. An empty one (`--ignore` with nothing after it) exits with an
 * error: it names no URL, and picomatch throws on it.
 */
export const parseIgnoreFlag = (
  rawArgs: readonly string[]
): ((url: string) => boolean) => {
  const globs = repeatedFlag(rawArgs, "ignore");
  if (globs.includes("")) {
    logger.error(
      'Invalid --ignore "": pass a glob for the URLs to skip (e.g. --ignore "https://example.com/**").'
    );
    process.exit(1);
  }
  return picomatch(globs, { dot: true });
};

/**
 * The longest `--timeout` a timer can hold, in seconds. Node clamps a
 * `setTimeout` delay above 2^31−1 ms (about 24.8 days) to 1 ms, so a larger
 * value would time every agent out the moment it starts.
 */
export const MAX_TIMEOUT_S = Math.floor(2_147_483_647 / 1000);

/**
 * Parse a `--timeout` value in whole seconds, or return `fallback` when unset.
 * A non-integer, non-positive, or too-long value exits with an error.
 */
export const parseTimeoutSeconds = (
  value: string | undefined,
  fallback: number
): number => {
  if (value === undefined) {
    return fallback;
  }
  const timeout = Number(value);
  if (!Number.isInteger(timeout) || timeout <= 0) {
    logger.error(`Invalid --timeout "${value}" (whole seconds).`);
    process.exit(1);
  }
  if (timeout > MAX_TIMEOUT_S) {
    logger.error(
      `Invalid --timeout "${value}" (at most ${MAX_TIMEOUT_S} seconds, about 24 days).`
    );
    process.exit(1);
  }
  return timeout;
};
