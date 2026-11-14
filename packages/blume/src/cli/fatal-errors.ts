import { reportInternalError } from "./internal-error.ts";

const exitOnUncaughtException: NodeJS.UncaughtExceptionListener = (error) => {
  reportInternalError(error);
  process.exit(1);
};

const exitOnUnhandledRejection: NodeJS.UnhandledRejectionListener = (
  reason
) => {
  reportInternalError(reason);
  process.exit(1);
};

/**
 * Report anything no command caught as `BLUME_INTERNAL` and exit, instead of
 * the runtime's bare stack trace.
 */
export const installFatalErrorHandlers = (): void => {
  process.on("uncaughtException", exitOnUncaughtException);
  process.on("unhandledRejection", exitOnUnhandledRejection);
};

/**
 * Leave unhandled rejections to Astro's dev server from here on. Once it is up,
 * it listens for them itself, records the error, and shows it in the browser
 * overlay, so `astro dev` keeps serving. Exiting on top of that turned a
 * recoverable error into a crash, such as the request an in-place config restart
 * strands while the dev app is still compiling.
 *
 * Without a listener of Astro's (an adapter whose server code doesn't run in
 * Node, such as workerd), Node raises the rejection as an uncaught exception,
 * which still reaches the handler above.
 */
export const leaveUnhandledRejectionsToAstro = (): void => {
  process.off("unhandledRejection", exitOnUnhandledRejection);
};
