import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { join } from "pathe";

/**
 * Two `blume dev` servers starting at the same moment must not both get the
 * lock — least of all when a stale lock is waiting to be taken over, where
 * one process's "clear the stale lock" used to delete the lock another had
 * just claimed. Real processes race here: each one waits at a shared start
 * line, calls `acquireDevLock`, reports whether it won, and a winner holds on
 * until every racer has reported.
 */

const DEV_LOCK = join(import.meta.dir, "..", "src", "cli", "dev-lock.ts");

const RACERS = 4;
const ROUNDS = 12;

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

const RACER = `import { existsSync } from "node:fs";
import { acquireDevLock, DevLockHeldError } from ${JSON.stringify(DEV_LOCK)};

const [outDir, go] = process.argv.slice(2);
process.stdout.write("ready\\n");
while (!existsSync(go)) {
  // Spin at the start line so every racer claims at once.
}
let outcome = "won";
try {
  acquireDevLock(outDir);
} catch (error) {
  if (!(error instanceof DevLockHeldError)) {
    throw error;
  }
  outcome = "held";
}
process.stdout.write(outcome + "\\n");
// A winner keeps its lock (by staying alive) until the test has every answer.
process.stdin.resume();
process.stdin.on("end", () => process.exit(0));
`;

interface Racer {
  exited: Promise<number>;
  lines: AsyncGenerator<string>;
  /** Close the racer's stdin, which lets a winner exit. */
  release: () => void;
}

/**
 * A stream's text, one line at a time.
 * @yields {string} Each complete line, without its newline.
 */
const readLines = async function* readLines(
  stream: ReadableStream<Uint8Array>
): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffered = "";
  for await (const chunk of stream) {
    buffered += decoder.decode(chunk, { stream: true });
    let newline = buffered.indexOf("\n");
    while (newline !== -1) {
      yield buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      newline = buffered.indexOf("\n");
    }
  }
};

const nextLine = async (racer: Racer): Promise<string> => {
  const { value } = await racer.lines.next();
  return value ?? "";
};

const spawnRacer = (script: string, outDir: string, go: string): Racer => {
  const proc = Bun.spawn([process.execPath, script, outDir, go], {
    stderr: "inherit",
    stdin: "pipe",
    stdout: "pipe",
  });
  return {
    exited: proc.exited,
    lines: readLines(proc.stdout),
    release: () => {
      proc.stdin.end();
    },
  };
};

/** One race: every racer claims `outDir` at once; returns their outcomes. */
const race = async (
  script: string,
  outDir: string,
  go: string
): Promise<string[]> => {
  const racers = Array.from({ length: RACERS }, () =>
    spawnRacer(script, outDir, go)
  );
  try {
    const ready = await Promise.all(racers.map(nextLine));
    expect(ready).toEqual(Array.from({ length: RACERS }, () => "ready"));
    writeFileSync(go, "");
    return await Promise.all(racers.map(nextLine));
  } finally {
    for (const racer of racers) {
      racer.release();
    }
    await Promise.all(racers.map((racer) => racer.exited));
  }
};

describe("acquireDevLock across processes", () => {
  it("lets exactly one of several simultaneous starts win", async () => {
    const root = await mkdtemp(join(tmpdir(), "blume-lock-race-"));
    dirs.push(root);
    const script = join(root, "racer.ts");
    await writeFile(script, RACER);

    for (let round = 0; round < ROUNDS; round += 1) {
      const outDir = join(root, `round-${round}`, ".blume");
      mkdirSync(outDir, { recursive: true });
      if (round % 2 === 0) {
        // A dead server's leftover: every racer wants to take it over.
        writeFileSync(join(outDir, "dev.lock"), '{"pid":2147483647}');
      }
      // oxlint-disable-next-line no-await-in-loop -- rounds must not overlap
      const outcomes = await race(script, outDir, join(root, `go-${round}`));
      expect(outcomes.filter((outcome) => outcome === "won")).toEqual(["won"]);
      expect(outcomes.filter((outcome) => outcome === "held")).toHaveLength(
        RACERS - 1
      );
    }
  }, 120_000);
});
