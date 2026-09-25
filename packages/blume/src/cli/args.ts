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
