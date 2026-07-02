import { expect, test } from "@playwright/test";

/**
 * Visual-regression baselines. Seed them once with
 * `bun run test:e2e -- --update-snapshots`, then commit the generated
 * `*-snapshots/` PNGs; later runs diff against them (per the config's
 * `maxDiffPixelRatio`).
 */

test("landing page (light)", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveScreenshot("landing-light.png", { fullPage: true });
});

test("docs page (light)", async ({ page }) => {
  await page.goto("/docs/quickstart");
  await expect(page).toHaveScreenshot("docs-light.png", { fullPage: true });
});

test("docs page (dark)", async ({ page }) => {
  await page.goto("/docs/quickstart");
  await page.locator("[data-blume-theme-toggle]").first().click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page).toHaveScreenshot("docs-dark.png", { fullPage: true });
});
