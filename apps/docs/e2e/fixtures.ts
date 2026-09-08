import { test as base } from "@playwright/test";

/**
 * Shared Playwright `test` that fails on any uncaught page error. Visiting a
 * page is not enough: an assertion on server-rendered markup passes even when
 * a shipped script throws at module load (a `<Component>` script once did on
 * `/docs/content/components`, and the suite that visited it stayed green).
 */
export const test = base.extend({
  page: async ({ page }, run) => {
    const errors: Error[] = [];
    page.on("pageerror", (error) => {
      errors.push(error);
    });
    await run(page);
    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        `Uncaught page error(s): ${errors.map((error) => error.message).join("; ")}`
      );
    }
  },
});

export { expect } from "@playwright/test";
