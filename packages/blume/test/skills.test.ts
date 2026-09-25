import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
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
  // A PAX extended header's `path` overrides the next entry's ustar name.
  let paxPath: string | undefined;
  while (offset < tar.length) {
    const header = tar.subarray(offset, offset + 512);
    const name = field(header.subarray(0, 100));
    if (!name) {
      break;
    }
    const prefix = field(header.subarray(345, 500));
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
    offset += 512 + Math.ceil(size / 512) * 512;
    if (header[156] === 0x78) {
      const record = /^(?<length>\d+) path=(?<path>.*)\n$/su.exec(content);
      expect(Number(record?.groups?.length)).toBe(
        new TextEncoder().encode(content).length
      );
      paxPath = record?.groups?.path;
      continue;
    }
    const path = paxPath ?? (prefix ? `${prefix}/${name}` : name);
    paxPath = undefined;
    files.push({ content, mode, path });
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

  it("rejects escaping paths", () => {
    const content = new Uint8Array(0);
    expect(() => buildTarGz([{ content, path: "../evil" }])).toThrow(
      "archive-relative"
    );
    expect(() => buildTarGz([{ content, path: "/abs" }])).toThrow(
      "archive-relative"
    );
  });

  // Paths past the 100-byte ustar `name` field: split across `prefix` up to
  // 255 bytes, then a PAX extended header. Components stay under the 255-byte
  // filename limit so the archive also extracts onto a real filesystem.
  const longEntries = [
    { content: "short\n", path: "SKILL.md" },
    // 134 bytes, split as `references` + name.
    { content: "split\n", path: `references/${"a".repeat(120)}.md` },
    // 250 bytes, the longest head that fits `prefix` (150 bytes).
    {
      content: "max split\n",
      executable: true,
      path: `${"d".repeat(150)}/${"n".repeat(99)}`,
    },
    // 181 bytes whose only split leaves a 160-byte head: PAX.
    { content: "unsplittable\n", path: `${"s".repeat(160)}/${"t".repeat(20)}` },
    // 316 bytes: PAX.
    {
      content: "pax\n",
      path: `references/${"x".repeat(100)}/${"y".repeat(100)}/${"z".repeat(100)}.md`,
    },
    // 275 bytes of multi-byte characters: PAX, with a UTF-8 record length.
    {
      content: "unicode\n",
      path: `${"文".repeat(30)}/${"文".repeat(30)}/${"文".repeat(30)}.md`,
    },
  ];
  const longArchive = (): Uint8Array =>
    buildTarGz(
      longEntries.map((entry) => ({
        ...entry,
        content: new TextEncoder().encode(entry.content),
      }))
    );

  it("archives paths longer than the ustar name field", () => {
    const files = readTarGz(longArchive());
    expect(files.map(({ content, path }) => ({ content, path }))).toEqual(
      longEntries.map(({ content, path }) => ({ content, path }))
    );
    expect(files[2]?.mode).toBe(0o755);
  });

  // Windows tar and MAX_PATH make long-path extraction host-dependent there;
  // the in-process reader above still checks the layout on every platform.
  it.skipIf(process.platform === "win32")(
    "extracts long paths with the system tar",
    async () => {
      const dir = join(root, "long-paths");
      await mkdir(join(dir, "out"), { recursive: true });
      await writeFile(join(dir, "skill.tar.gz"), longArchive());
      const result = spawnSync(
        "tar",
        ["-xzf", join(dir, "skill.tar.gz"), "-C", join(dir, "out")],
        { encoding: "utf-8" }
      );
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      for (const entry of longEntries) {
        const target = join(dir, "out", entry.path);
        expect(readFileSync(target, "utf-8")).toBe(entry.content);
        const { mode } = statSync(target);
        // oxlint-disable-next-line no-bitwise -- testing the owner-execute mode bit
        expect((mode & 0o100) !== 0).toBe(entry.executable === true);
      }
    }
  );
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
    // NTFS does not expose POSIX execute bits, so chmod cannot mark the
    // fixture executable on Windows.
    expect(files[1]?.mode).toBe(process.platform === "win32" ? 0o644 : 0o755);
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

  it("publishes one entry when two directories declare the same name", async () => {
    const dir = join(root, "colliding");
    // `alpha` sorts first and keeps the name; `beta` would otherwise write a
    // second index entry over the same artifact path.
    await mkdir(join(dir, "alpha"), { recursive: true });
    await writeFile(join(dir, "alpha", "SKILL.md"), skillMd("shared"));
    await mkdir(join(dir, "beta", "scripts"), { recursive: true });
    await writeFile(join(dir, "beta", "SKILL.md"), skillMd("shared"));
    await writeFile(join(dir, "beta", "scripts", "run.sh"), "echo beta\n");

    const { skills, warnings } = await collectSkills(dir);
    expect(skills.map((skill) => [skill.name, skill.type, skill.path])).toEqual(
      [["shared", "skill-md", "shared/SKILL.md"]]
    );
    expect(new TextDecoder().decode(skills[0]?.content)).toBe(
      skillMd("shared")
    );
    const expected = createHash("sha256")
      .update(skills[0]?.content ?? new Uint8Array())
      .digest("hex");
    expect(skills[0]?.digest).toBe(`sha256:${expected}`);
    expect(warnings).toEqual([
      'Skills "alpha" and "beta" both declare the name "shared"; publishing "alpha" and skipping "beta".',
    ]);
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
        deployment: { options: { base: "/base/" } },
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
