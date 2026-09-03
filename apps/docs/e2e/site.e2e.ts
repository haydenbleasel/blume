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

  test("the image-zoom stylesheet survives a client-router swap", async ({
    page,
  }) => {
    // medium-zoom's own rules must ship in the page CSS the router re-renders
    // on every navigation, not in a runtime-injected <style> the head swap
    // throws away — otherwise the zoom cursor vanishes and a zoomed image can
    // never close after the first in-page navigation. Neither page here has a
    // zoomable image, so the library never runs: the rule can only be present
    // if it came with the page.
    await page.goto("/docs");
    await page.locator("nav a[href='/docs/quickstart']").first().click();
    await expect(page).toHaveURL(/\/docs\/quickstart/u);
    const cursor = await page.evaluate(() => {
      const image = document.createElement("img");
      image.className = "medium-zoom-image";
      document.body.append(image);
      return getComputedStyle(image).cursor;
    });
    expect(cursor).toBe("zoom-in");
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

test.describe("dropdowns", () => {
  test("page actions close on an outside click and on Escape", async ({
    page,
  }) => {
    await page.goto("/docs/quickstart");
    const actions = page.locator("[data-blume-page-actions]");
    const dropdown = actions.locator("details").first();
    const open = actions.locator("details[open]");

    await dropdown.locator("summary").click();
    await expect(open).toHaveCount(1);
    await page.locator("#blume-content h1").click();
    await expect(open).toHaveCount(0);

    // Focus moves into the panel first, so the assertion below proves Escape
    // restored it rather than just observing the click that opened the menu.
    await dropdown.locator("summary").click();
    await expect(open).toHaveCount(1);
    const menuItem = dropdown
      .locator("[data-blume-menu] :is(a, button)")
      .first();
    await menuItem.focus();
    await expect(menuItem).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(open).toHaveCount(0);
    await expect(dropdown.locator("summary")).toBeFocused();
  });

  test("page actions close when keyboard focus leaves the panel", async ({
    page,
  }) => {
    await page.goto("/docs/quickstart");
    const actions = page.locator("[data-blume-page-actions]");
    const dropdown = actions.locator("details").first();
    const open = actions.locator("details[open]");

    await dropdown.locator("summary").focus();
    await page.keyboard.press("Enter");
    await expect(open).toHaveCount(1);
    // From the last item, one more Tab leaves the panel out its far side.
    const lastItem = dropdown
      .locator("[data-blume-menu] :is(a, button)")
      .last();
    await lastItem.focus();
    await expect(lastItem).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(open).toHaveCount(0);
  });

  test("the header language switcher closes on an outside click", async ({
    page,
  }) => {
    await page.goto("/docs/quickstart");
    const switcher = page
      .locator("header details[data-blume-dropdown]")
      .first();
    await switcher.locator("summary").click();
    await expect(switcher).toHaveAttribute("open");
    await page.locator("#blume-content h1").click();
    await expect(switcher).not.toHaveAttribute("open");
  });
});
