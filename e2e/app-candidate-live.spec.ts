import { test, expect } from "./fixtures";

// LIVE end-to-end: drive the Assistant to actually build an app, exercising the
// real model + developer sub-agent + `contentOnly` routing + draft install. This
// is intentionally NON-DETERMINISTic (it calls the live LLM); a failure here is a
// model/harness signal, not necessarily a code defect — the wiring itself is
// proven deterministically in app-candidate.spec.ts.
//
// Run against the Supervisor port: BOS_E2E_BASE_URL=http://localhost:8090.
test.describe.configure({ mode: "serial" });
test.use({ video: "off" });

test.describe("app candidate — live build via the Assistant", () => {
  test.afterEach(async ({ request }) => {
    await request.post("/__supervisor/app-discard").catch(() => {});
  });

  test("typing a build request creates an app candidate", async ({ page, request }) => {
    test.setTimeout(360_000); // model + multi-step developer sub-agent

    await page.getByTestId("dock-chat").click();
    const win = page.getByTestId("window-chat");
    await expect(win).toBeVisible();

    // Start a fresh conversation so prior (old-pattern) context doesn't bias the model.
    await win.getByRole("button", { name: "New conversation" }).click().catch(() => {});

    const input = win.getByRole("textbox").first();
    await input.fill(
      "Build a small app called 'E2E Sound' with a single button that plays a short beep (Web Audio) when clicked. Keep it self-contained.",
    );
    await input.press("Enter");

    // The assistant should delegate (contentOnly) → install a draft → an app
    // candidate appears. Generous timeout for the live sub-agent run.
    const promote = page.getByRole("button", { name: "Promote app" });
    await expect(promote).toBeVisible({ timeout: 330_000 });

    // Sanity: the candidate is reflected in supervisor state.
    const state = await (await request.get("/__supervisor/state")).json();
    expect(state.appCandidate).not.toBeNull();
  });
});
