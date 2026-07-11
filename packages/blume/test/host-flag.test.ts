import { describe, expect, it } from "bun:test";

import { join } from "pathe";

/**
 * `--host` is declared as a citty string arg (citty 0.1 has no mixed
 * string/boolean arg type), so a bare `--host` parses as `""` — which Vite's
 * `resolveHostname` would treat as a literal hostname and print malformed URLs
 * like `http://:4321/`. `normalizeHost` maps the parsed value onto Astro's own
 * `--host` semantics. The command modules are imported in a subprocess so they
 * stay out of the coverage run, like the other command suites.
 */

const PKG_ROOT = join(import.meta.dir, "..");
const COMMANDS = join(PKG_ROOT, "src", "cli", "commands");

const script = `
  const { parseArgs } = await import("citty");
  const { devCommand, normalizeHost } = await import(
    ${JSON.stringify(join(COMMANDS, "dev.ts"))}
  );
  const { previewCommand } = await import(
    ${JSON.stringify(join(COMMANDS, "preview.ts"))}
  );
  const host = (cmd, rawArgs) =>
    normalizeHost(parseArgs(rawArgs, cmd.args).host);
  console.log(
    JSON.stringify({
      devAbsent: host(devCommand, []),
      devBare: host(devCommand, ["--host"]),
      devBareBeforeFlag: host(devCommand, ["--host", "--open"]),
      devBareRaw: parseArgs(["--host"], devCommand.args).host,
      devExplicit: host(devCommand, ["--host", "10.0.0.1"]),
      previewBare: host(previewCommand, ["--host"]),
      previewExplicit: host(previewCommand, ["--host", "0.0.0.0"]),
    })
  );
`;

describe("--host flag normalization", () => {
  it("maps a bare --host to true and an explicit value to itself", async () => {
    const proc = Bun.spawn(["bun", "-e", script], {
      cwd: PKG_ROOT,
      stderr: "pipe",
      stdout: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);

    const parsed = JSON.parse(stdout);
    // The citty quirk this guards against: a valueless string flag is "".
    expect(parsed.devBareRaw).toBe("");
    // Bare `--host` binds all interfaces (Astro's boolean semantics), whether
    // it sits at the end of the argv or before another flag.
    expect(parsed.devBare).toBe(true);
    expect(parsed.devBareBeforeFlag).toBe(true);
    expect(parsed.previewBare).toBe(true);
    // An explicit address passes through; an absent flag stays localhost-only.
    expect(parsed.devExplicit).toBe("10.0.0.1");
    expect(parsed.previewExplicit).toBe("0.0.0.0");
    expect(parsed.devAbsent).toBe(false);
  });
});
