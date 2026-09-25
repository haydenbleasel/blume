import { gzipSync } from "node:zlib";

import { createTar } from "nanotar";

/**
 * `.tar.gz` writer for agent-skill archives, on nanotar's ustar writer.
 * Deterministic by construction — fixed mtime/uid/gid/owner attrs,
 * caller-ordered entries, and Node's gzip header carries no timestamp — so a
 * skill's archive digest only changes when its content does. That holds per
 * machine: the tar bytes are portable, but zlib's compressed stream differs
 * across architectures, so gzip-layer digests are not comparable across
 * platforms.
 */

/** One regular file to archive. Paths are `/`-separated, relative, no `..`. */
export interface TarEntry {
  /** Raw file bytes. */
  content: Uint8Array;
  /** Preserve the owner-execute bit (e.g. a skill's scripts). */
  executable?: boolean;
  /** Archive-relative path, e.g. `SKILL.md` or `references/FORMS.md`. */
  path: string;
}

/** ustar `name` field capacity. */
const NAME_MAX = 100;
/** ustar `prefix` field capacity; `prefix/name` reaches 255 bytes. */
const PREFIX_MAX = 155;

/** ustar header byte offsets nanotar leaves for us to patch. */
const CHECKSUM_OFFSET = 148;
const CHECKSUM_SIZE = 8;
const TYPEFLAG_OFFSET = 156;
const PREFIX_OFFSET = 345;
const BLOCK_SIZE = 512;

/** The two zero blocks that mark the end of an archive. */
const END_OF_ARCHIVE = 2 * BLOCK_SIZE;
/** tar's default record size (20 blocks), which the archive is padded to. */
const RECORD_SIZE = 20 * BLOCK_SIZE;

/** The PAX extended-header typeflag (`x`). */
const PAX_TYPEFLAG = 0x78;

const encoder = new TextEncoder();

const byteLength = (value: string): number => encoder.encode(value).byteLength;

/** `value` cut to at most `max` UTF-8 bytes, on a character boundary. */
const truncateBytes = (value: string, max: number): string =>
  value.slice(0, encoder.encodeInto(value, new Uint8Array(max)).read);

/** One header nanotar writes, plus the fields it cannot. */
interface Block {
  content: Uint8Array;
  mode: string;
  name: string;
  /** The PAX extended header ahead of an over-long path. */
  pax?: boolean;
  /** ustar `prefix`, joined to `name` with a `/` by readers. */
  prefix?: string;
}

/**
 * Split a path over the `name` field at a `/` so the head fits `prefix` and
 * the tail fits `name`. The longest head that fits leaves the shortest tail,
 * so if that tail is still too long no split works.
 */
const splitUstar = (
  path: string
): { name: string; prefix: string } | undefined => {
  let slash = path.lastIndexOf("/");
  while (slash > 0 && byteLength(path.slice(0, slash)) > PREFIX_MAX) {
    slash = path.lastIndexOf("/", slash - 1);
  }
  const name = path.slice(slash + 1);
  if (slash <= 0 || byteLength(name) > NAME_MAX) {
    return undefined;
  }
  return { name, prefix: path.slice(0, slash) };
};

/**
 * A PAX `path` record: `"<length> path=<value>\n"`, where the decimal length
 * counts the whole record including its own digits.
 */
const paxPathRecord = (path: string): Uint8Array => {
  const body = ` path=${path}\n`;
  const size = byteLength(body);
  const length = size + String(size + String(size).length).length;
  return encoder.encode(`${length}${body}`);
};

/**
 * The header blocks for one entry. A path that fits `name` is written as is;
 * up to 255 bytes it splits across `prefix` and `name`; beyond that (or with
 * no usable split) a PAX extended header carries the full path and the ustar
 * `name` holds a truncated fallback for readers that ignore PAX.
 */
const entryBlocks = (entry: TarEntry): Block[] => {
  const mode = entry.executable ? "755" : "644";
  const file = { content: entry.content, mode };
  if (byteLength(entry.path) <= NAME_MAX) {
    return [{ ...file, name: entry.path }];
  }
  const split = splitUstar(entry.path);
  if (split) {
    return [{ ...file, ...split }];
  }
  const base = entry.path.slice(entry.path.lastIndexOf("/") + 1);
  return [
    {
      content: paxPathRecord(entry.path),
      mode: "644",
      name: truncateBytes(`PaxHeader/${base}`, NAME_MAX),
      pax: true,
    },
    { ...file, name: truncateBytes(base, NAME_MAX) },
  ];
};

/** Recompute a patched header's checksum (nanotar's octal format). */
const writeChecksum = (header: Uint8Array): void => {
  header.fill(0x20, CHECKSUM_OFFSET, CHECKSUM_OFFSET + CHECKSUM_SIZE);
  const sum = header.reduce((total, byte) => total + byte, 0);
  header.fill(0, CHECKSUM_OFFSET, CHECKSUM_OFFSET + CHECKSUM_SIZE);
  encoder.encodeInto(
    sum.toString(8),
    header.subarray(CHECKSUM_OFFSET, CHECKSUM_OFFSET + CHECKSUM_SIZE)
  );
};

/**
 * Build a gzipped ustar archive of the given files, in the given order. Paths
 * escaping the archive root throw to surface a programming error.
 */
export const buildTarGz = (entries: readonly TarEntry[]): Uint8Array => {
  for (const entry of entries) {
    if (entry.path.startsWith("/") || entry.path.split("/").includes("..")) {
      throw new Error(`tar path must be archive-relative: ${entry.path}`);
    }
  }
  const blocks = entries.flatMap(entryBlocks);
  const tar = createTar(
    blocks.map((block) => ({
      // Root-owned, epoch-mtime, empty owner names: every field a rebuild
      // could vary is pinned so the archive bytes are a function of content.
      attrs: {
        gid: 0,
        group: "",
        mode: block.mode,
        mtime: 0,
        uid: 0,
        user: "",
      },
      data: block.content,
      name: block.name,
    }))
  );
  // nanotar writes neither `prefix` nor the PAX typeflag, so patch those
  // headers in place and re-sum them.
  let offset = 0;
  for (const block of blocks) {
    const header = tar.subarray(offset, offset + BLOCK_SIZE);
    if (block.prefix) {
      encoder.encodeInto(
        block.prefix,
        header.subarray(PREFIX_OFFSET, PREFIX_OFFSET + PREFIX_MAX)
      );
      writeChecksum(header);
    }
    if (block.pax) {
      header[TYPEFLAG_OFFSET] = PAX_TYPEFLAG;
      writeChecksum(header);
    }
    offset +=
      BLOCK_SIZE * (1 + Math.ceil(block.content.byteLength / BLOCK_SIZE));
  }
  // nanotar pads the entries to a whole record but writes no end-of-archive
  // marker, so entries ending within two blocks of a record boundary leave
  // fewer than the two zero blocks readers expect (GNU tar warns "A lone zero
  // block"). Pad to the first record that fits both; for every other archive
  // that is the size nanotar already wrote, so its bytes are unchanged.
  const archive = new Uint8Array(
    Math.ceil((offset + END_OF_ARCHIVE) / RECORD_SIZE) * RECORD_SIZE
  );
  archive.set(tar.subarray(0, offset));
  // Sync gzip with a pinned level; Node writes no timestamp into the header.
  return new Uint8Array(gzipSync(archive, { level: 9 }));
};
