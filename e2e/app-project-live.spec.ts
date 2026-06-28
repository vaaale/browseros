import { test, expect } from "./fixtures";

// LIVE end-to-end for the multi-file PROJECT path: drive the Assistant to build
// a real TypeScript/React app (multiple files) — exercising the project flow
// (developer authors into a staging dir → buildApp → esbuild → app-candidate).
// Non-deterministic (real LLM); a failure is a model/harness signal. The build
// pipeline itself is proven deterministically in app-candidate.spec.ts and the
// /api/apps/build endpoint test.
//
// Run against the Supervisor port: BOS_E2E_BASE_URL=http://localhost:8090.
test.describe.configure({ mode: "serial" });
test.use({ video: "off" });

test.describe("app project — live multi-file build via the Assistant", () => {
  test.afterEach(async ({ request }) => {
    await request.post("/__supervisor/app-discard").catch(() => {});
  });

  test("building a multi-file React app creates a built app candidate", async ({ page, request }) => {
    test.setTimeout(360_000);

    await page.getByTestId("dock-chat").click();
    const win = page.getByTestId("window-chat");
    await expect(win).toBeVisible();

    const input = win.getByRole("textbox").first();
    await expect(input).toBeEditable({ timeout: 15_000 });
    await input.click();
    await input.fill(
      "Build a BrowserOS app called 'Live Counter' as a real multi-file TypeScript React project (not a single HTML file): a Counter component in its own file with a button that increments a count, imported by the entry. Use React.",
    );
    await input.press("Enter");
    // Confirm the message actually sent (CopilotKit clears the input on submit).
    await expect(input).toHaveValue("", { timeout: 10_000 });

    const promote = page.getByRole("button", { name: "Promote app" });
    await expect(promote).toBeVisible({ timeout: 330_000 });

    // Confirm it's a *built* candidate: the app serves a bundle.js (esbuild output).
    const state = await (await request.get("/__supervisor/state")).json();
    expect(state.appCandidate).not.toBeNull();
    const apps = (await (await request.get("/api/apps")).json()).apps as { id: string }[];
    const built = apps.find((a) => a.id === "live-counter");
    expect(built, "live-counter app should be installed").toBeTruthy();
    const bundle = await request.get("/apps/live-counter/bundle.js");
    expect(bundle.status(), "built app should serve an esbuild bundle.js").toBe(200);
  });
});
