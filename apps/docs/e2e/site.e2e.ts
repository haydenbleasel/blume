import { expect, test } from "@playwright/test";

test.describe("navigation", () => {
  test("home renders and links into the docs", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(/Blume/iu);
  });

  test("sidebar navigates between docs pages", async ({ page }) => {
    await page.goto("/docs");
    const link = page.locator("nav a[href='/docs/quickstart']").first();
    await expect(link).toBeVisible();
    await link.click();
    await expect(page).toHaveURL(/\/docs\/quickstart/u);
  });
});

test.describe("theme toggle", () => {
  test("flips the color scheme", async ({ page }) => {
    await page.goto("/docs");
    const html = page.locator("html");
    const before = await html.getAttribute("data-theme");
    await page.locator("[data-blume-theme-toggle]").first().click();
    await expect(html).not.toHaveAttribute("data-theme", before ?? "");
  });
});

test.describe("mobile sidebar", () => {
  test.use({ viewport: { height: 800, width: 480 } });

  test("opens and closes the drawer", async ({ page }) => {
    await page.goto("/docs");
    const html = page.locator("html");
    await page.locator("[data-blume-nav-toggle]").first().click();
    await expect(html).toHaveAttribute("data-blume-nav-open", "");
  });
});

test.describe("search", () => {
  test("opens the search dialog and accepts a query", async ({ page }) => {
    await page.goto("/docs");
    await page.locator("[data-blume-search-open]").first().click();
    const dialog = page.locator("[data-blume-search-dialog]");
    await expect(dialog).toBeVisible();
    await page.locator("[data-blume-search-input]").fill("quickstart");
    await expect(dialog).toContainText(/quickstart/iu);
    await page.keyboard.press("Escape");
  });
});

test.describe("content components", () => {
  test("code blocks expose a copy button", async ({ page }) => {
    await page.goto("/docs/quickstart");
    const copy = page.locator("[data-blume-copy]").first();
    await expect(copy).toBeVisible();
    await copy.click();
  });

  test("tabs switch panels", async ({ page }) => {
    await page.goto("/docs/content/components");
    const tabs = page.locator("blume-tabs").first();
    await expect(tabs).toBeAttached();
  });
});

test.describe("custom pages", () => {
  test("the landing page renders with the shared chrome", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("header").first()).toBeVisible();
  });
});
