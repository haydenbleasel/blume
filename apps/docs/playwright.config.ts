import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end + accessibility tests for the Blume docs site (a real Blume
 * project, so this doubles as the framework's browser coverage). Playwright
 * builds and previews the site, then drives it in a headless browser.
 *
 * Run: `bun run test:e2e` (install browsers first with `bunx playwright install`).
 */
const PORT = 4321;

export default defineConfig({
  // Visual-regression baselines live beside the specs, committed per-OS.
  expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.02 } },
  forbidOnly: Boolean(process.env.CI),
  fullyParallel: true,
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  reporter: process.env.CI ? "github" : "list",
  retries: process.env.CI ? 1 : 0,
  testDir: "./e2e",
  // `.e2e.ts`, not `.spec.ts`, so Bun's test runner (`bun test`) doesn't try to
  // load these Playwright specs under the wrong runner.
  testMatch: "**/*.e2e.ts",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "on-first-retry",
  },
  webServer: {
    command: "bun run build && bun run preview",
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    url: `http://localhost:${PORT}`,
  },
});
