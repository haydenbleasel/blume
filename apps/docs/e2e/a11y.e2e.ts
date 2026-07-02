import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

/**
 * Serious/critical structural WCAG 2 A/AA violations on a page. `color-contrast`
 * is disabled here and gated separately (see the content-contrast test below):
 * syntax-highlighting tokens and brand-accent text are design decisions that
 * can't be blanket AA-gated, so folding them into the structural gate is noise.
 */
const seriousViolations = async (page: Page) => {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa"])
    .disableRules(["color-contrast"])
    .analyze();
  return results.violations.filter(
    (violation) =>
      violation.impact === "serious" || violation.impact === "critical"
  );
};

for (const path of ["/", "/docs", "/docs/quickstart"]) {
  test(`no serious accessibility violations on ${path}`, async ({ page }) => {
    await page.goto(path);
    const violations = await seriousViolations(page);
    expect(
      violations,
      violations.map((violation) => violation.id).join(", ")
    ).toEqual([]);
  });
}

test("the skip link is the first focusable element", async ({ page }) => {
  await page.goto("/docs");
  await page.keyboard.press("Tab");
  const focused = await page.evaluate(
    () => document.activeElement?.textContent ?? ""
  );
  expect(focused).toMatch(/skip to content/iu);
});

/** Contrast on real article content (excluding code, whose syntax colors are
 * theme-defined) must meet AA in both themes. */
const contentContrast = (page: Page) =>
  new AxeBuilder({ page })
    .include("main")
    .exclude("pre")
    .withRules(["color-contrast"])
    .analyze();

test("content text meets AA contrast in light and dark", async ({ page }) => {
  await page.goto("/docs/quickstart");
  const light = await contentContrast(page);
  expect(light.violations, "light mode").toEqual([]);

  await page.locator("[data-blume-theme-toggle]").first().click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const dark = await contentContrast(page);
  expect(dark.violations, "dark mode").toEqual([]);
});

test("renders under reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/docs");
  await expect(page.locator("main").first()).toBeVisible();
});
