import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

/** WCAG 2 A/AA violations at serious/critical impact on a page. */
const seriousViolations = async (page: Page) => {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa"])
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

test("dark mode keeps text contrast within AA", async ({ page }) => {
  await page.goto("/docs");
  await page.locator("[data-blume-theme-toggle]").first().click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2aa"])
    .analyze();
  const violations = results.violations.filter(
    (violation) => violation.id === "color-contrast"
  );
  expect(violations).toEqual([]);
});

test("renders under reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/docs");
  await expect(page.locator("main").first()).toBeVisible();
});
