import { test, expect } from "./fixtures";

// Elicitation cards (dev_branch_request → FeatureBranchCard) must appear in
// the Build Studio chat on every path that can raise one: a direct model
// call, a delegated inner loop, after another chat window
// registered/unregistered the shared global handlers (regression:
// last-write-wins Map dropped them), and after the window was minimized while
// the call arrived (regression: unmounted handlers meant the dispatch was
// silently dropped with no retry).
//
// NOTE: there used to be a "server tool raises the card itself via
// ctx.elicit" case here (spec_write without an active branch). Commit
// 183caa1 ("Unified file tools") retired spec_write and folded spec writes
// into the generic file_edit/file_patch tools, which have no ctx.elicit path
// at all (grep finds zero ctx.elicit call sites in src/) — writing under
// /Specs with no active branch now just throws a plain SpecFSNoContextError
// string, and the tool description tells the MODEL to call dev_branch_request
// itself in response. That's a model-driven recovery, not an automatic card,
// so it isn't deterministically scriptable here the way the other cases are.
const script = (turns: unknown[]) => `@@e2e ${JSON.stringify({ turns })}`;

async function openBuildStudio(page: import("@playwright/test").Page) {
  await page.getByTestId("dock-build-studio").click();
  const win = page.getByTestId("window-build-studio");
  await expect(win).toBeVisible();
  const textarea = win.getByTestId("chat-textarea");
  await expect(textarea).toBeVisible({ timeout: 15000 });
  return { win, textarea };
}

test("direct call: dev_branch_request shows the branch card", async ({ page }) => {
  const { win, textarea } = await openBuildStudio(page);
  await textarea.fill(
    script([
      { text: "setting up a branch", tools: [{ name: "dev_branch_request", args: { task: "repro test" } }] },
      { text: "done" },
    ]),
  );
  await win.getByTestId("chat-send-button").click();
  await expect(win.getByTestId("branch-card")).toBeVisible({ timeout: 30000 });
});

test("multi-chat: opening then closing the Chat app must not break BS elicitations", async ({ page }) => {
  const { win, textarea } = await openBuildStudio(page);
  // Open the Assistant (chat) app — its AssistantChatV2 registers the same
  // global frontend tools — then close it again.
  await page.getByTestId("dock-chat").click();
  const chatWin = page.getByTestId("window-chat");
  await expect(chatWin).toBeVisible();
  await expect(chatWin.getByTestId("chat-textarea")).toBeVisible({ timeout: 15000 });
  await chatWin.getByLabel("Close").click();
  await expect(chatWin).toHaveCount(0);

  await textarea.fill(
    script([
      { text: "setting up a branch", tools: [{ name: "dev_branch_request", args: { task: "repro test" } }] },
      { text: "done" },
    ]),
  );
  await win.getByTestId("chat-send-button").click();
  await expect(win.getByTestId("branch-card")).toBeVisible({ timeout: 30000 });
});

test("minimized BS: a call arriving while minimized shows the card after restore", async ({ page }) => {
  const { win, textarea } = await openBuildStudio(page);
  // Delay the model turn so the tool call lands while the window is minimized.
  await textarea.fill(
    script([
      { text: "thinking ".repeat(20), deltas: 20, delayMs: 300, tools: [{ name: "dev_branch_request", args: { task: "repro test" } }] },
      { text: "done" },
    ]),
  );
  await win.getByTestId("chat-send-button").click();
  await win.getByLabel("Minimize").click();
  await expect(win).toHaveCount(0);
  await page.waitForTimeout(8000);
  // Restore from the dock.
  await page.getByTestId("dock-build-studio").click();
  await expect(page.getByTestId("window-build-studio")).toBeVisible();
  await expect(page.getByTestId("window-build-studio").getByTestId("branch-card")).toBeVisible({ timeout: 15000 });
});

test("inner-loop: a delegated local agent calling dev_branch_request shows the branch card", async ({ page }) => {
  const { win, textarea } = await openBuildStudio(page);
  const innerTask = script([
    { text: "inner asks for a branch", tools: [{ name: "dev_branch_request", args: { task: "repro inner" } }] },
    { text: "inner done" },
  ]);
  await textarea.fill(
    script([
      {
        text: "delegating",
        tools: [
          {
            name: "agent_delegate",
            args: {
              task: innerTask,
              ephemeralName: "Repro Agent",
              ephemeralType: "local",
              ephemeralSystemPrompt: "You are a repro agent.",
            },
          },
        ],
      },
      { text: "outer done" },
    ]),
  );
  await win.getByTestId("chat-send-button").click();
  await expect(win.getByTestId("branch-card")).toBeVisible({ timeout: 30000 });
});
