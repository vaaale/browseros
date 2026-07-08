import { test as base, expect } from "@playwright/test";

// Shared fixture: each test starts on a ready desktop. globalSetup marks setup
// complete so the first-run wizard stays closed; the Skip click is a defensive
// fallback (and is non-persistent) in case it appears anyway.
export const test = base.extend({
  // `runTest` is Playwright's fixture-use callback (named to avoid the
  // react-hooks lint rule that treats a `use(...)` call as a React hook).
  page: async ({ page }, runTest) => {
    await page.goto("/");
    const skip = page.getByRole("button", { name: "Skip" });
    if (await skip.isVisible().catch(() => false)) {
      await skip.click().catch(() => {});
    }
    await runTest(page);
  },
});

export { expect };
