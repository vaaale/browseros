import { test, expect } from "./fixtures";

// App-candidate (GitFS) preview/promote/discard, driven through the Topbar's
// VersionControls. Deterministic: the candidate is seeded via the apps API
// (draft install → app-candidate branch under the Supervisor), NOT via the LLM.
//
// REQUIRES running against the Supervisor's public port so /__supervisor/state
// resolves and the controls render — set BOS_E2E_BASE_URL=http://localhost:8090.
// Tests mutate shared Supervisor state (a single app candidate), so run serially.
test.describe.configure({ mode: "serial" });
// Video capture needs an ffmpeg binary that isn't installed here; disable it
// (screenshots-on-failure still work and need no extra binary).
test.use({ video: "off" });

test.describe("app candidate — Topbar promote/discard", () => {
  test.afterEach(async ({ request }) => {
    // Safety net: drop any candidate this test left behind.
    await request.post("/__supervisor/app-discard").catch(() => {});
  });

  test("draft install shows candidate controls; Promote keeps the app live", async ({ page, request }) => {
    const seed = await request.post("/api/apps", {
      data: { name: "E2E Promote", draft: true, html: "<!doctype html><title>E2E Promote</title><body>promote me</body>" },
    });
    expect(seed.ok()).toBeTruthy();

    // Controls appear once the Topbar polls /__supervisor/state and sees the candidate.
    const promote = page.getByRole("button", { name: "Promote app" });
    await expect(promote).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("app preview")).toBeVisible();

    await promote.click();

    // Candidate gone, app merged live (served + listed).
    await expect(promote).toBeHidden({ timeout: 15_000 });
    const served = await request.get("/apps/e2e-promote");
    expect(served.status()).toBe(200);
    const list = await (await request.get("/api/apps")).json();
    expect((list.apps as { id: string }[]).some((a) => a.id === "e2e-promote")).toBeTruthy();

    // Cleanup: remove the promoted test app so the repo stays at the base apps.
    await request.delete("/api/apps?id=e2e-promote&purge=1");
  });

  test("Discard drops the candidate app entirely", async ({ page, request }) => {
    const seed = await request.post("/api/apps", {
      data: { name: "E2E Discard", draft: true, html: "<!doctype html><title>E2E Discard</title><body>discard me</body>" },
    });
    expect(seed.ok()).toBeTruthy();

    const discard = page.getByRole("button", { name: "Discard app" });
    await expect(discard).toBeVisible({ timeout: 15_000 });
    await discard.click();

    // Candidate gone; the app is not served and not listed.
    await expect(discard).toBeHidden({ timeout: 15_000 });
    const served = await request.get("/apps/e2e-discard");
    expect(served.status()).toBe(404);
    const list = await (await request.get("/api/apps")).json();
    expect((list.apps as { id: string }[]).some((a) => a.id === "e2e-discard")).toBeFalsy();
  });
});
