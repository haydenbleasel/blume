import { describe, expect, it } from "bun:test";

import matter from "../src/core/frontmatter.ts";
import { validateTranslation } from "../src/translate/validate.ts";

/**
 * A source saved with a byte order mark still has frontmatter: gray-matter
 * strips the BOM before it looks for the fence. Validation has to agree, or
 * it reconstructs a frontmatter-less file and the translation loses its
 * title, description, and every other key.
 */

const SOURCE = "﻿---\ntitle: Install\norder: 2\n---\n# Install\n\nRun it.\n";

describe("validateTranslation with a BOM-prefixed source", () => {
  it("keeps the reconstructed frontmatter", () => {
    const result = validateTranslation(
      SOURCE,
      "---\ntitle: Installer\norder: 9\n---\n# Installer\n\nLancez-le.\n"
    );
    expect(result.ok).toBe(true);
    // SAFETY: the assertion above has already failed the test unless ok.
    const { text } = result as { ok: true; text: string };
    const parsed = matter(text);
    expect(parsed.data).toEqual({ order: 2, title: "Installer" });
    expect(parsed.content).toContain("Lancez-le.");
  });

  it("still requires the translation to keep its frontmatter", () => {
    const result = validateTranslation(SOURCE, "# Installer\n\nLancez-le.\n");
    expect(result).toEqual({
      ok: false,
      reason: "translation dropped the frontmatter (must start with ---)",
    });
  });
});
