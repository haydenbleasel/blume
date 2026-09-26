import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";

import { EN_UI } from "../src/core/i18n-ui.ts";

/**
 * Source-level guards for the header's icon buttons (search, the theme toggle,
 * and the assistant), each named by a tooltip, and for the repository link
 * that moved from the header to the site footer. The `.astro` files render
 * only inside a built site, so these pin the markup the header relies on.
 */
const source = async (path: string): Promise<string> => {
  const text = await readFile(
    new URL(`../src/components/${path}`, import.meta.url),
    "utf-8"
  );
  // A Windows checkout may carry CRLF line endings.
  return text.replaceAll("\r\n", "\n");
};

describe("the header's icon buttons", () => {
  it("name themselves in a tooltip", async () => {
    const [header, search, assistant] = await Promise.all([
      source("layout/Header.astro"),
      source("layout/Search.astro"),
      source("islands/assistant.tsx"),
    ]);
    expect(header).toContain("data-blume-tooltip={n.toggleTheme}");
    expect(header).toContain("content: attr(data-blume-tooltip);");
    expect(assistant).toContain("data-blume-tooltip={t.open}");
    // Search is an icon button whose tooltip carries the shortcut, with Ctrl
    // swapped in off Apple devices.
    expect(search).toMatch(
      /data-blume-tooltip=\{`\$\{s\.button\} \(\\u2066⌘K\\u2069\)`\}/u
    );
    expect(search).toContain('aria-keyshortcuts="Meta+K Control+K"');
    expect(search).toContain("(\\u2066Ctrl K\\u2069)");
    expect(EN_UI.assistant.open).toBe("Open assistant");
    expect(EN_UI.nav.toggleTheme).toBe("Toggle theme");
  });

  it("sit together, with search first and no repository link", async () => {
    const header = await source("layout/Header.astro");
    // One right-hand group with a tight gap: pickers, links, then icons.
    const cluster = header.slice(
      header.indexOf(
        '<div class="flex shrink-0 items-center gap-1 lg:col-start-3 lg:justify-self-end">'
      )
    );
    expect(cluster.indexOf("<NavSelector")).toBeGreaterThan(0);
    expect(cluster.indexOf("<LanguageSwitcher")).toBeLessThan(
      cluster.indexOf("<SearchSlot")
    );
    expect(cluster.indexOf("<SearchSlot")).toBeGreaterThan(0);
    expect(cluster.indexOf("<SearchSlot")).toBeLessThan(
      cluster.indexOf("data-blume-theme-toggle")
    );
    expect(header).not.toContain("repoUrl");
  });
});

describe("the header's tabs", () => {
  it("sit at the center from lg, between a shrinkable logo side and the controls", async () => {
    const header = await source("layout/Header.astro");
    // The logo side can shrink to nothing (its title truncates); the controls
    // never shrink below their width, so they can't run into the tabs.
    expect(header).toContain(
      "lg:grid lg:grid-cols-[minmax(0,1fr)_auto_minmax(max-content,1fr)]"
    );
    expect(header).toContain(
      '<div class="flex min-w-0 items-center gap-2 sm:gap-3 lg:col-start-1">'
    );
    expect(header).toContain('class:list={[tabsNavClass, "lg:col-start-2"]}');
    // Below lg the spacer keeps the tabs beside the logo.
    expect(header).toContain('<div class="flex-1 lg:hidden"></div>');
  });
});

describe("the repository link", () => {
  it("is the footer's, as navigation.repo leaves it", async () => {
    const [footer, page] = await Promise.all([
      source("layout/SiteFooter.astro"),
      source("layout/PageLayout.astro"),
    ]);
    expect(footer).toContain("const repoUrl = navigation?.repoUrl;");
    expect(footer).toContain("githubRepository");
    expect(page).toContain("navigation={navigation}");
  });
});

describe("the header's pickers", () => {
  it("drop the border in the header, like the icon buttons", async () => {
    const [switcher, selector] = await Promise.all([
      source("layout/LanguageSwitcher.astro"),
      source("layout/NavSelector.astro"),
    ]);
    for (const picker of [switcher, selector]) {
      expect(picker).toContain(
        '"inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-full px-3 text-muted-foreground text-sm transition-colors hover:bg-muted hover:text-foreground group-open:bg-muted group-open:text-foreground"'
      );
    }
  });

  it("show the language's name, with no globe, and rows that fit", async () => {
    const switcher = await source("layout/LanguageSwitcher.astro");
    expect(switcher).not.toContain('name="globe"');
    expect(switcher).toContain("{current?.label ?? label}");
    // The panel grows to its longest row, and the untranslated note sits
    // past the name instead of squeezing it.
    expect(switcher).toContain(
      '"end-0 w-max min-w-44 max-w-[calc(100vw-1rem)]"'
    );
    expect(switcher).toContain(
      '<span class="ms-auto flex items-center gap-2.5">'
    );
  });
});
