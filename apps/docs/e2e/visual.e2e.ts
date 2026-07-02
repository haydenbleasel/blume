import { expect, test } from "@playwright/test";

/**
 * Visual-regression baselines. Opt-in (they need per-OS PNG baselines committed,
 * which are brittle across machines) — enable with `VISUAL=1`:
 *
 *   VISUAL=1 bun run test:e2e -- --update-snapshots   # seed baselines, then commit
 *   VISUAL=1 bun run test:e2e                          # diff against them
 *
 * Without `VISUAL`, they're skipped so the default suite stays green.
 */
const visual = process.env.VISUAL ? test : test.skip;

visual("landing page (light)", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveScreenshot("landing-light.png", { fullPage: true });
});

visual("docs page (light)", async ({ page }) => {
  await page.goto("/docs/quickstart");
  await expect(page).toHaveScreenshot("docs-light.png", { fullPage: true });
});

visual("docs page (dark)", async ({ page }) => {
  await page.goto("/docs/quickstart");
  await page.locator("[data-blume-theme-toggle]").first().click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page).toHaveScreenshot("docs-dark.png", { fullPage: true });
});
