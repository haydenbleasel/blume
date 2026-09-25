import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";

import { tailwindEntryTemplate } from "../src/theme/entry.ts";

/**
 * Source-level guards for the reader-facing chrome: the print stylesheet, the
 * sidebar (its subtree cache, drill-in panels, logical spacing), the header's
 * logo, selectors, tab dropdowns and banner, and the RTL mirroring of
 * directional glyphs. The `.astro` files render only inside a built site, so
 * these pin the markup and script contracts the fixes rely on.
 */
const source = async (path: string): Promise<string> => {
  const text = await readFile(
    new URL(`../src/${path}`, import.meta.url),
    "utf-8"
  );
  // A Windows checkout may carry CRLF line endings.
  return text.replaceAll("\r\n", "\n");
};

const sources = (paths: string[]): Promise<string[]> =>
  Promise.all(paths.map(source));

const entry = tailwindEntryTemplate({
  configTokens: "",
  sources: [],
  userTheme: "",
});

describe("print stylesheet", () => {
  const hidden =
    /@media print \{\s*(?<selectors>[^{]+)\{\s*display: none !important;/u.exec(
      entry
    )?.groups?.selectors ?? "";
  const selectors = hidden
    .split(",")
    .map((selector) => selector.trim())
    .filter(Boolean);

  it("hides the site chrome by marker, never every header or aside", () => {
    // Content renders <aside> (Callout, Panel) and <header> (a changelog
    // Update): a bare tag selector dropped them from Export → PDF.
    expect(selectors).not.toContain("header");
    expect(selectors).not.toContain("aside");
    expect(selectors).toEqual(
      expect.arrayContaining([
        "[data-blume-banner]",
        "[data-blume-header]",
        "body > header",
        "[data-blume-nav-drawer]",
        "[data-blume-toc]",
        "[data-blume-assistant-panel]",
        "[data-blume-page-actions]",
      ])
    );
  });

  it("marks every chrome element the rule names", async () => {
    const [header, root, page, assistant] = await sources([
      "components/layout/Header.astro",
      "components/layout/RootLayout.astro",
      "components/layout/PageLayout.astro",
      "components/islands/assistant.tsx",
    ]);
    expect(header).toContain("data-blume-header\n");
    expect(root).toContain("data-blume-nav-drawer");
    expect(root).toContain("data-blume-toc");
    expect(page).toContain("data-blume-nav-drawer");
    expect(assistant).toContain('data-blume-assistant-panel=""');
  });
});

describe("sidebar", () => {
  it("caches sprite and inline renders of a subtree apart", async () => {
    // The /blume-nav/ fragment route renders with no icon sprite; reusing a
    // page render's `<use href="#blume-i-…">` there left icons blank.
    const cache = await source("components/layout/NavTreeCache.astro");
    expect(cache).toContain(`\`\${variant}|\${sprite ? "sprite" : "inline"}\``);
  });

  it("ties each drill button to the panel it opens", async () => {
    const tree = await source("components/layout/NavTree.astro");
    expect(tree).toContain(
      `const navPanelId = (id: string): string => \`blume-nav-panel-\${id}\`;`
    );
    expect(tree).toContain("id={navPanelId(panel.id)}");
    expect(tree).toMatch(
      /aria-controls=\{navPanelId\(id\)\}\s*aria-expanded="false"\s*class="blume-nav-drill"\s*data-nav-to=\{id\}/u
    );
  });

  it("moves focus into the panel it shows and syncs aria-expanded", async () => {
    const script = await source("components/layout/NavTreeScript.astro");
    expect(script).toContain(
      "const hadFocus = prev?.contains(document.activeElement) ?? false;"
    );
    expect(script).toContain("this.syncExpanded(next);");
    expect(script).toContain("this.focusInto(next, prev);");
    // Going back lands on the drill button that opened the panel; drilling
    // in lands on the new panel's back button.
    expect(script).toContain(`\`[data-nav-to="\${prev.dataset.navPanel}"]\``);
    expect(script).toContain(
      'next.querySelector<HTMLElement>("button, a[href]")'
    );
    expect(script).toContain("target?.focus({ preventScroll: true });");
  });

  it("appends a deferred panel's rows below its back row", async () => {
    // Swapping the fragment in as the panel's innerHTML wiped the Back button
    // and title the panel renders above its rows.
    const script = await source("components/layout/NavTreeScript.astro");
    expect(script).toContain('slot.insertAdjacentHTML("beforeend", html);');
    expect(script).not.toContain("slot.innerHTML =");
  });

  it("uses logical spacing so the tree mirrors in RTL", async () => {
    const tree = await source("components/layout/NavTree.astro");
    for (const physical of [
      "-ml-1",
      "text-left",
      "border-l ",
      "pl-3",
      "ml-auto",
    ]) {
      expect(tree).not.toContain(physical);
    }
    expect(tree).toContain("border-s ps-3");
    expect(tree).toContain("-ms-1");
    expect(tree).toContain("ms-auto");
    const drill = /@utility blume-nav-drill \{[^}]*\}/u.exec(entry)?.[0];
    expect(drill).toContain("text-start");
    expect(drill).not.toContain("text-left");
  });
});

describe("header", () => {
  it("names an image-only logo link", async () => {
    const logo = await source("components/layout/Logo.astro");
    expect(logo).toContain(
      "const linkLabel = brandText ? undefined : logoAlt || site.title;"
    );
    expect(logo).toContain("aria-label={linkLabel}");
  });

  it("keeps the selector's visible label in its accessible name", async () => {
    const selector = await source("components/layout/NavSelector.astro");
    expect(selector).toContain(
      `label === selector.label ? selector.label : \`\${selector.label}: \${label}\`;`
    );
    expect(selector).toContain("aria-label={summaryLabel}");
  });

  it("renders a tab with items as a dropdown in the bar and the drawers", async () => {
    const [header, root, page, menu] = await sources([
      "components/layout/Header.astro",
      "components/layout/RootLayout.astro",
      "components/layout/PageLayout.astro",
      "components/layout/NavTabMenu.astro",
    ]);
    expect(header).toMatch(
      /tab\.items && tab\.items\.length > 0 \? \(\s*<NavTabMenu[\s\S]*?variant="bar"/u
    );
    for (const layout of [root, page]) {
      expect(layout).toMatch(
        /tab\.items && tab\.items\.length > 0 \? \(\s*<NavTabMenu[\s\S]*?variant="drawer"/u
      );
    }
    // The header dropdown opts into the shared light-dismiss and clamp.
    expect(menu).toContain(
      '<details class="group relative" data-blume-dropdown>'
    );
    expect(menu).toContain("data-blume-dropdown-panel");
    expect(menu).toContain("installDropdownDismiss();");
    expect(menu).toContain("installDropdownClamp();");
    // The drawer variant expands in place, open on the tab's own section.
    expect(menu).toContain('<details class="group" open={active}>');
    expect(menu).toContain("href={withMountedBase(item.path)}");
  });

  it("routes the banner link through the locale's navigation", async () => {
    const [banner, ...shells] = await sources([
      "components/layout/Banner.astro",
      "components/layout/RootLayout.astro",
      "components/layout/PageLayout.astro",
      "components/layout/ReferenceLayout.astro",
    ]);
    expect(banner).toContain("(navigation.bannerHref ?? banner.link.href)");
    expect(banner).toContain("href={withBase(linkHref)}");
    for (const shell of shells) {
      expect(shell).toContain(
        "<Banner banner={banner} locale={locale} strings={strings.banner} />"
      );
    }
  });

  it("passes the reference shell's localized strings to the header", async () => {
    const reference = await source("components/layout/ReferenceLayout.astro");
    expect(reference).toContain("navStrings={navStrings}");
    expect(reference).toContain("searchStrings={strings.search}");
    expect(reference).toContain("switcherStrings={strings.languageSwitcher}");
  });
});

describe("content components", () => {
  it("bases a TypeTable type link like any component link", async () => {
    const table = await source("components/content/TypeTable.astro");
    expect(table).toContain("href={contentHref(info.typeDescriptionLink)}");
  });

  it("reads their chrome labels from the UI string packs", async () => {
    const [table, component, tabs, expandable, update, github, search] =
      await sources([
        "components/content/TypeTable.astro",
        "components/content/Component.astro",
        "components/content/Tabs.astro",
        "components/content/Expandable.astro",
        "components/content/Update.astro",
        "components/content/GithubInfo.astro",
        "components/layout/Search.astro",
      ]);
    for (const key of ["prop", "type", "default"]) {
      expect(table).toContain(`{strings.${key}}`);
    }
    expect(component).toContain("title={strings.preview}");
    expect(component).toContain("title={strings.code}");
    expect(tabs).toContain("data-i18n-tab={strings.tab}");
    expect(tabs).toContain("this.dataset.i18nSelectTab");
    expect(expandable).toContain("title = strings.showMore");
    expect(update).toContain("label ?? title ?? strings.update");
    // The anchor stays locale-independent.
    expect(update).toContain('componentSlug(label ?? title ?? "") || "update"');
    expect(github).toContain('<span class="sr-only">{strings.stars}: </span>');
    expect(github).toContain('<span class="sr-only">{strings.forks}: </span>');
    expect(search).toContain("data-i18n-latest={s.latest}");
    expect(search).toContain("escapeHtml(hit.version || this.latestMsg)");
  });

  it("mirrors directional arrows in RTL", async () => {
    const [card, tile, banner, assistant] = await sources([
      "components/content/Card.astro",
      "components/content/Tile.astro",
      "components/layout/Banner.astro",
      "components/islands/assistant.tsx",
    ]);
    for (const markup of [card, tile, banner]) {
      const arrows = (markup ?? "").match(
        /<Icon[^>]*name="arrow-right"[^>]*>/gu
      );
      expect(arrows?.length).toBeGreaterThan(0);
      for (const arrow of arrows ?? []) {
        expect(arrow).toContain("rtl:-scale-x-100");
      }
    }
    expect(assistant).toMatch(
      /className="rtl:-scale-x-100"\s*path=\{icons\.close\}/u
    );
  });
});
