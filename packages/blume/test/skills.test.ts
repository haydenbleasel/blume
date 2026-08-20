import { afterAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { gunzipSync } from "node:zlib";

import { join } from "pathe";

import { buildSkillsIndex, collectSkills } from "../src/ai/skills.ts";
import { buildTarGz } from "../src/ai/tar.ts";
import type { ResolvedConfig } from "../src/core/schema.ts";

const root = mkdtempSync(join(tmpdir(), "blume-skills-"));

afterAll(async () => {
  await rm(root, { force: true, recursive: true });
});

const skillMd = (name: string): string =>
  `---\nname: ${name}\ndescription: Test skill ${name}.\n---\n\n# ${name}\n`;

/** Parse the (path, mode, content) triples out of a gzipped ustar archive. */
const decoder = new TextDecoder();

/** A tar header field: the bytes before the first NUL, whitespace trimmed. */
const field = (bytes: Uint8Array): string => {
  const end = bytes.indexOf(0);
  return decoder.decode(end === -1 ? bytes : bytes.subarray(0, end)).trim();
};

const readTarGz = (
  bytes: Uint8Array
): { content: string; mode: number; path: string }[] => {
  const tar = new Uint8Array(gunzipSync(bytes));
  const files: { content: string; mode: number; path: string }[] = [];
  let offset = 0;
  while (offset < tar.length) {
    const header = tar.subarray(offset, offset + 512);
    const path = field(header.subarray(0, 100));
    if (!path) {
      break;
    }
    const mode = Number.parseInt(field(header.subarray(100, 108)), 8);
    const size = Number.parseInt(field(header.subarray(124, 136)), 8);
    // Validate the checksum the way a tar reader does.
    let sum = 0;
    for (let index = 0; index < 512; index += 1) {
      const byte = header[index] ?? 0;
      sum += index >= 148 && index < 156 ? 0x20 : byte;
    }
    const stored = Number.parseInt(field(header.subarray(148, 156)), 8);
    expect(sum).toBe(stored);
    const content = decoder.decode(
      tar.subarray(offset + 512, offset + 512 + size)
    );
    files.push({ content, mode, path });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
};

describe("buildTarGz", () => {
  it("produces a valid, deterministic ustar archive", () => {
    const entries = [
      { content: new TextEncoder().encode("# hi\n"), path: "SKILL.md" },
      {
        content: new TextEncoder().encode("echo ok\n"),
        executable: true,
        path: "scripts/run.sh",
      },
    ];
    const first = buildTarGz(entries);
    expect(Buffer.from(first).equals(Buffer.from(buildTarGz(entries)))).toBe(
      true
    );
    const files = readTarGz(first);
    expect(files.map((file) => file.path)).toEqual([
      "SKILL.md",
      "scripts/run.sh",
    ]);
    expect(files[0]?.content).toBe("# hi\n");
    expect(files[0]?.mode).toBe(0o644);
    expect(files[1]?.mode).toBe(0o755);
  });

  it("pins the tar bytes for a fixed entry set", () => {
    // Golden digest of the UNCOMPRESSED tar. If this fails, the writer's byte
    // layout changed and the digest of EVERY published skill archive will
    // churn on the next build — consumers see every skill as updated. Bump the
    // constant only when that churn is deliberate (it last changed when the
    // writer moved to nanotar). The gzip layer is deliberately excluded: its
    // bytes vary across platforms (zlib's compressor differs by architecture),
    // so only the tar layout is pinnable.
    const entries = [
      { content: new TextEncoder().encode("# hi\n"), path: "SKILL.md" },
      {
        content: new TextEncoder().encode("echo ok\n"),
        executable: true,
        path: "scripts/run.sh",
      },
    ];
    const digest = createHash("sha256")
      .update(gunzipSync(buildTarGz(entries)))
      .digest("hex");
    expect(`sha256:${digest}`).toBe(
      "sha256:70642ad8d5a6f4db4153c9d7cf99a1026e134b3852ff04d0df28a54d06f32c75"
    );
  });

  it("rejects escaping and oversized paths", () => {
    const content = new Uint8Array(0);
    expect(() => buildTarGz([{ content, path: "../evil" }])).toThrow(
      "archive-relative"
    );
    expect(() => buildTarGz([{ content, path: "/abs" }])).toThrow(
      "archive-relative"
    );
    expect(() => buildTarGz([{ content, path: `${"a".repeat(101)}` }])).toThrow(
      "exceeds"
    );
  });
});

describe("collectSkills", () => {
  it("publishes single-file skills verbatim and bundles resource skills", async () => {
    const dir = join(root, "skills");
    await mkdir(join(dir, "simple"), { recursive: true });
    await writeFile(join(dir, "simple", "SKILL.md"), skillMd("simple"));
    await mkdir(join(dir, "bundled", "scripts"), { recursive: true });
    await writeFile(join(dir, "bundled", "SKILL.md"), skillMd("bundled"));
    await writeFile(
      join(dir, "bundled", "scripts", "run.sh"),
      "#!/bin/sh\necho ok\n"
    );
    await chmod(join(dir, "bundled", "scripts", "run.sh"), 0o755);
    // Noise that must be ignored: dotfiles and skill-less directories.
    await writeFile(join(dir, ".DS_Store"), "junk");
    await mkdir(join(dir, "not-a-skill"), { recursive: true });
    await writeFile(join(dir, "not-a-skill", "README.md"), "no SKILL.md");

    const { skills, warnings } = await collectSkills(dir);
    expect(warnings).toEqual([]);
    expect(skills.map((skill) => [skill.name, skill.type, skill.path])).toEqual(
      [
        ["bundled", "archive", "bundled.tar.gz"],
        ["simple", "skill-md", "simple/SKILL.md"],
      ]
    );

    const simple = skills.find((skill) => skill.name === "simple");
    expect(new TextDecoder().decode(simple?.content)).toBe(skillMd("simple"));
    const expected = createHash("sha256")
      .update(simple?.content ?? new Uint8Array())
      .digest("hex");
    expect(simple?.digest).toBe(`sha256:${expected}`);

    const bundled = skills.find((skill) => skill.name === "bundled");
    const files = readTarGz(bundled?.content ?? new Uint8Array());
    expect(files.map((file) => file.path)).toEqual([
      "SKILL.md",
      "scripts/run.sh",
    ]);
    expect(files[1]?.mode).toBe(0o755);
  });

  it("warns about invalid skills instead of publishing them", async () => {
    const dir = join(root, "invalid");
    await mkdir(join(dir, "Bad_Name"), { recursive: true });
    await writeFile(
      join(dir, "Bad_Name", "SKILL.md"),
      "---\nname: Bad_Name\ndescription: x\n---\n"
    );
    await mkdir(join(dir, "nameless"), { recursive: true });
    await writeFile(join(dir, "nameless", "SKILL.md"), "# no frontmatter\n");
    await mkdir(join(dir, "garbled"), { recursive: true });
    await writeFile(
      join(dir, "garbled", "SKILL.md"),
      "---\nname: [unclosed\n---\n"
    );

    const { skills, warnings } = await collectSkills(dir);
    expect(skills).toEqual([]);
    expect(warnings).toHaveLength(3);
    expect(warnings.join(" ")).toContain("invalid name");
    expect(warnings.join(" ")).toContain("missing the required");
    expect(warnings.join(" ")).toContain("unparsable");
  });
});

describe("buildSkillsIndex", () => {
  it("emits the v0.2.0 index with based, path-absolute artifact URLs", async () => {
    const dir = join(root, "indexed");
    await mkdir(join(dir, "simple"), { recursive: true });
    await writeFile(join(dir, "simple", "SKILL.md"), skillMd("simple"));
    const { skills } = await collectSkills(dir);
    // SAFETY: buildSkillsIndex reads only deployment.base off the config.
    const index = JSON.parse(
      buildSkillsIndex(skills, {
        deployment: { base: "/base/" },
      } as ResolvedConfig)
    );
    expect(index.$schema).toBe(
      "https://schemas.agentskills.io/discovery/0.2.0/schema.json"
    );
    expect(index.skills).toEqual([
      {
        description: "Test skill simple.",
        digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
        name: "simple",
        type: "skill-md",
        url: "/base/.well-known/agent-skills/simple/SKILL.md",
      },
    ]);
  });
});
