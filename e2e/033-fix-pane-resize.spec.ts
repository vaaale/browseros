import { test, expect, type Page } from "./fixtures";

// End-to-end regression test for 033-fix-pane-resize (P1/P2 acceptance
// scenarios). Drives real pointer input against Build Studio's right
// (chat) ResizeHandle while an HTML mockup iframe sits in the center pane —
// the exact scenario that used to drop the pointer mid-drag, leave the pane
// stuck to the cursor after release, and flood the log with benign
// "ResizeObserver loop" window errors.

const HTML_PATH = "user-specs/e2e-033-pane-resize-test/mockup.html";
const HTML_CONTENT = "<!doctype html><html><body><h1>Mockup</h1><p>A UI mockup preview.</p></body></html>";

const script = (turns: unknown[]) => `@@e2e ${JSON.stringify({ turns })}`;

async function writeMockup(page: Page): Promise<void> {
  const res = await page.request.put("/api/specs", {
    data: { path: HTML_PATH, content: HTML_CONTENT, branch: "bos/e2e-033-resize" },
  });
  expect(res.ok()).toBeTruthy();
}

async function openBuildStudioWithMockup(page: Page) {
  await page.getByTestId("dock-build-studio").click();
  const win = page.getByTestId("window-build-studio");
  await expect(win).toBeVisible();
  await expect(win.getByTestId("chat-textarea")).toBeVisible({ timeout: 15000 });

  // Drive the scripted e2e provider's buildstudio_artifact_open tool directly
  // (same pattern as e2e/013-spec-anchor.spec.ts) rather than clicking through
  // the tree: the containing Project node starts collapsed on a fresh window,
  // and this tool call expands every ancestor of the opened file itself.
  await win.getByTestId("chat-textarea").fill(
    script([{ text: "opening the mockup", tools: [{ name: "buildstudio_artifact_open", args: { path: HTML_PATH } }] }, { text: "Opened." }]),
  );
  await win.getByTestId("chat-send-button").click();
  await expect(win.getByText("Opened.")).toBeVisible({ timeout: 30000 });

  const iframe = win.locator("iframe");
  await expect(iframe).toBeVisible({ timeout: 20000 });
  return { win, iframe };
}

test.describe("033 fix pane resize", () => {
  test("dragging the right separator across the mockup iframe tracks the pointer, ends cleanly on release, and does not ghost-resize afterward", async ({ page }) => {
    test.setTimeout(90_000);
    await writeMockup(page);
    const { win, iframe } = await openBuildStudioWithMockup(page);

    const aside = win.locator("aside");
    const beforeBox = (await aside.boundingBox())!;
    const iframeBox = (await iframe.boundingBox())!;

    // Press on the separator (immediately left of the chat aside) and drag
    // the pointer INTO the iframe region and back out before releasing —
    // without pointer capture this used to drop the move/up events the
    // instant the cursor crossed into the iframe's own document.
    const y = beforeBox.y + beforeBox.height / 2;
    await page.mouse.move(beforeBox.x - 2, y);
    await page.mouse.down();
    await page.mouse.move(iframeBox.x + iframeBox.width / 2, y, { steps: 10 });
    await page.mouse.move(beforeBox.x - 152, y, { steps: 10 });
    await page.mouse.up();

    const afterBox = (await aside.boundingBox())!;
    // Dragging left by ~150px grows the (inverted) right pane by ~150px —
    // proves the drag tracked the pointer through the iframe crossing
    // instead of dropping it.
    expect(afterBox.width).toBeGreaterThan(beforeBox.width + 80);

    // The drag session must have ended exactly on release: hovering the
    // pointer back over the separator's new position afterward must not
    // resume resizing (no residual state left the session "stuck").
    const stableWidth = afterBox.width;
    await page.mouse.move(afterBox.x - 2, y);
    await page.mouse.move(afterBox.x + 60, y, { steps: 5 });
    await page.mouse.move(afterBox.x - 2, y, { steps: 5 });
    await page.waitForTimeout(200);
    const hoverBox = (await aside.boundingBox())!;
    expect(hoverBox.width).toBe(stableWidth);
  });

  test("a full drag sweep across the iframe produces no 'ResizeObserver loop' window-error log records", async ({ page }) => {
    test.setTimeout(90_000);
    await writeMockup(page);
    const { win, iframe } = await openBuildStudioWithMockup(page);

    const sessionId = await page.evaluate(() => window.sessionStorage.getItem("bos.sessionId"));
    expect(sessionId).toBeTruthy();
    const since = Date.now();

    const aside = win.locator("aside");
    const asideBox = (await aside.boundingBox())!;
    const iframeBox = (await iframe.boundingBox())!;
    const y = asideBox.y + asideBox.height / 2;

    // Sweep the right separator back and forth across the iframe several
    // times — the drag-time reflow pattern most likely to trip the browser's
    // benign ResizeObserver loop notification if it were still reachable.
    for (let i = 0; i < 3; i++) {
      await page.mouse.move(asideBox.x - 2 - i * 20, y);
      await page.mouse.down();
      await page.mouse.move(iframeBox.x + iframeBox.width / 2, y, { steps: 8 });
      await page.mouse.move(asideBox.x - 100, y, { steps: 8 });
      await page.mouse.up();
    }

    // Left separator sweep too — both handles share the fixed component.
    const tree = win.getByTestId("build-studio-tree");
    const treeBox = (await tree.boundingBox())!;
    await page.mouse.move(treeBox.x + treeBox.width + 2, y);
    await page.mouse.down();
    await page.mouse.move(iframeBox.x + iframeBox.width / 2, y, { steps: 8 });
    await page.mouse.move(treeBox.x + treeBox.width + 60, y, { steps: 8 });
    await page.mouse.up();

    // The client-side browser logger batches on a 2s interval — give it (and
    // the server write) time to land before reading the log back.
    await page.waitForTimeout(2500);
    const res = await page.request.get(`/api/logs?component=window.onerror&session=${sessionId}&since=${since}`);
    expect(res.ok()).toBeTruthy();
    const { records } = (await res.json()) as { records?: Array<{ msg?: string }> };
    const resizeLoopRecords = (records ?? []).filter((r) => (r.msg ?? "").includes("ResizeObserver loop"));
    expect(resizeLoopRecords).toEqual([]);
  });
});
