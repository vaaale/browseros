import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";

// Regression test for the Event Viewer Configuration tab scroll defect: with
// more handler groups than fit the tab height, the panel used to clip its
// content (no scroll container) so lower groups were unreachable.
//
// Fully self-contained — every network call the Event Viewer makes is routed
// to a deterministic stub, so this never depends on (or mutates) the machine's
// real event store, and never hangs on the live NDJSON event stream.

const GROUP_COUNT = 24;
const TYPES = Array.from({ length: GROUP_COUNT }, (_, i) => `com.bos.e2e-scroll.type-${String(i).padStart(2, "0")}`);

function stubHandlers(): Record<string, unknown> {
  const groups: Record<string, unknown> = {};
  for (const [i, type] of TYPES.entries()) {
    groups[type] = {
      headless: [
        {
          handlerId: `scroll-headless-${i}`,
          displayName: `Scroll Headless ${i}`,
          icon: "Server",
          enabled: true,
          timeoutMs: 30_000,
          recentFailures: 0,
          ownerId: "e2e-scroll",
        },
      ],
      ui: [
        {
          handlerId: `scroll-ui-${i}`,
          displayName: `Scroll UI ${i}`,
          icon: "Puzzle",
          description: "Stubbed UI handler",
          isDefault: false,
          ownerId: "e2e-scroll",
          launch: { appId: "html-viewer" },
        },
      ],
    };
  }
  return groups;
}

async function stubEventApis(page: Page) {
  // The config tab's own data source — the only response that matters here.
  await page.route("**/api/events/handlers", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(stubHandlers()) }),
  );
  // The Events tab's list + footer counts: empty, so nothing races the config tab.
  await page.route("**/api/events/count", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ unreadTotal: 0, pendingTotal: 0, grandTotal: 0 }),
    }),
  );
  await page.route("**/api/events?*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ events: [], nextCursor: null, unreadTotal: 0 }),
    }),
  );
  // The live NDJSON stream would otherwise stay open for the whole test and
  // periodically force a refetch — close it immediately with an empty body.
  await page.route("**/api/events/stream*", (route) =>
    route.fulfill({ status: 200, contentType: "application/x-ndjson", body: "" }),
  );
}

test.describe.configure({ mode: "serial" });

test.describe("Event Viewer — Configuration tab scrolling", () => {
  test("the Configuration tab scrolls when it has more handler groups than fit", async ({ page }) => {
    await stubEventApis(page);
    // Re-load so the stubs apply from the desktop's very first fetch.
    await page.goto("/");

    await page.getByTitle(/event/i).first().click();
    await expect(page.getByTestId("event-viewer")).toBeVisible();

    await page.getByRole("button", { name: "Configuration" }).click();

    const panel = page.getByTestId("config-panel");
    await expect(panel).toBeVisible();

    const lastType = TYPES[TYPES.length - 1];
    const lastGroup = page.getByTestId(`config-group-${lastType}`);
    await expect(page.getByTestId(`config-group-${TYPES[0]}`)).toBeVisible();
    await expect(lastGroup).toBeAttached();

    // 1. The panel is a real scroll container whose content overflows it.
    const metrics = await panel.evaluate((el) => ({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      overflowY: getComputedStyle(el).overflowY,
    }));
    expect(metrics.clientHeight).toBeGreaterThan(0);
    expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
    expect(["auto", "scroll"]).toContain(metrics.overflowY);

    // 2. Scrolling to the bottom actually moves the content...
    await panel.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await expect.poll(async () => panel.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);

    // 3. ...and brings the last group into view inside the tab. On the unfixed
    // base the content is clipped, so the last group never becomes visible.
    await expect(lastGroup).toBeVisible();
    const box = await lastGroup.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThan(0);

    const panelBox = await panel.boundingBox();
    expect(panelBox).not.toBeNull();
    expect(box!.y).toBeGreaterThanOrEqual(panelBox!.y - 1);
    expect(box!.y + box!.height).toBeLessThanOrEqual(panelBox!.y + panelBox!.height + 1);
  });
});
