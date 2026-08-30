import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";

// E2E coverage for 034-event-notification-system (FR-030). Runs against the
// real dev server's real event store (same convention as e2e/global-setup.ts
// — "until BOS supports a separate data dir, e2e runs against the app's real
// data dir; the suite is written to be non-destructive").
//
// Self-cleaning (FR-030): every test unregisters any handler and clears any
// preference it created. Events themselves have NO delete/purge API by
// design (FR-002/the spec's "indefinite retention, never auto-pruned") — the
// achievable, spec-compliant cleanup for an event is marking it READ so it
// never lingers as unread noise in the bell/inbox; tests do this either as
// part of their own flow (clicking marks read) or explicitly in `finally`.
// All test event types are namespaced under a per-run-unique
// `com.bos.e2e-test.*` / `com.bos.e2e-<n>.*` root so runs never collide.

function uniqueSuffix(): string {
  return `${test.info().workerIndex}-${test.info().repeatEachIndex}-${Math.random().toString(36).slice(2, 8)}`;
}

async function emitTestEvent(page: Page, type: string, summary: string) {
  const res = await page.request.post("/api/events", {
    data: { type, payload: { summary }, source: { appId: "e2e-test", name: "E2E Test" } },
  });
  expect(res.ok()).toBeTruthy();
  return res.json() as Promise<{ id: string; sequence: number }>;
}

async function markRead(page: Page, eventId: string) {
  await page.request.post(`/api/events/${encodeURIComponent(eventId)}/read`).catch(() => {});
}

async function unregisterHandler(page: Page, handlerId: string, ownerId: string) {
  await page.request.post("/api/events/unregister", { data: { handlerId, ownerId } }).catch(() => {});
}

async function clearPreference(page: Page, eventType: string) {
  await page.request.post("/api/events/preference", { data: { eventType, preferredHandlerId: null } }).catch(() => {});
}

async function openEventViewer(page: Page) {
  await page.getByTitle(/event/i).first().click();
  await expect(page.getByTestId("event-viewer")).toBeVisible();
}

test.describe("Event & Notification System (034)", () => {
  test("US1: emitting an event shows it unread with correct metadata; clicking marks it read and moves it to historical", async ({ page }) => {
    const type = `com.bos.e2e-test.viewed-${uniqueSuffix()}`;
    const emitted = await emitTestEvent(page, type, `E2E viewer test ${uniqueSuffix()}`);
    try {
      await openEventViewer(page);

      const row = page.getByTestId(`event-row-${emitted.id}`);
      await expect(row).toBeVisible();
      await expect(row).toContainText(type);
      await expect(row).toContainText(`seq ${emitted.sequence}`);
      await expect(row).toContainText("processed"); // no headless handlers registered for this type → immediate

      await row.click();
      // No UI handler registered for this type → the generic detail view opens
      // inside the viewer (FR-017), and the row leaves the unread list.
      await expect(page.getByTestId("event-detail")).toBeVisible();
      await expect(page.getByTestId("event-detail")).toContainText(type);
      await expect(page.getByTestId("event-detail")).toContainText("No UI handler is registered");

      await page.getByRole("button", { name: "Back to events" }).click();
      await expect(page.getByTestId(`event-row-${emitted.id}`)).toBeHidden();

      await page.getByText("Show historical").click();
      await expect(page.getByTestId(`event-row-${emitted.id}`)).toBeVisible();
    } finally {
      await markRead(page, emitted.id);
    }
  });

  test("US1: bell count reflects unread state and 'Mark all as read' clears it", async ({ page }) => {
    const type = `com.bos.e2e-test.bell-${uniqueSuffix()}`;
    const before = await page.request.get("/api/events/count").then((r) => r.json());
    const emitted = await emitTestEvent(page, type, "E2E bell test");
    try {
      await expect
        .poll(async () => (await page.request.get("/api/events/count").then((r) => r.json())).unreadTotal)
        .toBe(before.unreadTotal + 1);

      await openEventViewer(page);
      await page.getByTestId("mark-all-read").click();

      await expect
        .poll(async () => (await page.request.get("/api/events/count").then((r) => r.json())).unreadTotal)
        .toBe(before.unreadTotal);
    } finally {
      await markRead(page, emitted.id);
    }
  });

  test("US3: a headless handler acknowledging transitions the event to processed", async ({ page }) => {
    const ownerId = `e2e-core-${uniqueSuffix()}`;
    const type = `com.bos.${ownerId}.thing.happened`;
    const handlerId = `handler-${uniqueSuffix()}`;
    await page.request.post("/api/events/register", {
      data: { handlerId, eventType: type, mode: "headless", ownerId, displayName: "E2E Core Handler", declaredBy: "core" },
    });
    const emitted = await emitTestEvent(page, type, "E2E headless test");
    try {
      // Ack directly (as a handler would) — settleAck always wins over a
      // concurrent internal retry loop when no callId is supplied (there is
      // no real worker behind this synthetic handler, so it would otherwise
      // fail with "no core executor registered").
      await page.request.post(`/api/events/${encodeURIComponent(emitted.id)}/ack`, {
        data: { handlerId, callerId: ownerId, result: { ok: true } },
      });

      await openEventViewer(page);

      const row = page.getByTestId(`event-row-${emitted.id}`);
      await expect(row).toBeVisible();
      await expect(row).toContainText("processed");

      await row.click();
      await expect(page.getByTestId("event-detail")).toContainText(handlerId);
    } finally {
      await markRead(page, emitted.id);
      await unregisterHandler(page, handlerId, ownerId);
    }
  });

  test("US5: clicking an event with exactly one UI handler launches that app", async ({ page }) => {
    const type = `com.bos.html-viewer.e2e-${uniqueSuffix()}`;
    const handlerId = `e2e-ui-${uniqueSuffix()}`;
    await page.request.post("/api/events/register", {
      data: {
        handlerId,
        eventType: type,
        mode: "ui",
        ownerId: "html-viewer",
        displayName: "Open in HTML Viewer",
        launch: { appId: "html-viewer" },
      },
    });
    const emitted = await emitTestEvent(page, type, "E2E UI handler test");
    try {
      await openEventViewer(page);
      await page.getByTestId(`event-row-${emitted.id}`).click();

      await expect(page.getByTestId("window-html-viewer")).toBeVisible();
      // Marked read as part of the click flow — verify via the API rather
      // than the (now-hidden, singleton-focused-elsewhere) row.
      await expect
        .poll(async () => {
          const full = await page.request.get(`/api/events/${encodeURIComponent(emitted.id)}`).then((r) => r.json());
          return full.read;
        })
        .toBe("read");
    } finally {
      await markRead(page, emitted.id);
      await unregisterHandler(page, handlerId, "html-viewer");
    }
  });

  test("US6: two UI handlers prompt a selection dialog; 'always use' sets a default that skips the dialog next time", async ({ page }) => {
    const type = `com.bos.html-viewer.e2e-ambiguous-${uniqueSuffix()}`;
    const handlerA = `e2e-ui-a-${uniqueSuffix()}`;
    const handlerB = `e2e-ui-b-${uniqueSuffix()}`;
    await page.request.post("/api/events/register", {
      data: {
        handlerId: handlerA,
        eventType: type,
        mode: "ui",
        ownerId: "html-viewer",
        displayName: "Handler A",
        launch: { appId: "html-viewer" },
      },
    });
    await page.request.post("/api/events/register", {
      data: {
        handlerId: handlerB,
        eventType: type,
        mode: "ui",
        ownerId: "html-viewer",
        displayName: "Handler B",
        launch: { appId: "html-viewer" },
      },
    });
    const first = await emitTestEvent(page, type, "E2E ambiguity test 1");
    const second = await emitTestEvent(page, type, "E2E ambiguity test 2");
    try {
      await openEventViewer(page);
      await page.getByTestId(`event-row-${first.id}`).click();

      const dialog = page.getByTestId("handler-dialog");
      await expect(dialog).toBeVisible();
      await page.getByTestId(`handler-option-${handlerA}`).click();
      await page.locator('label:has-text("Always")').click();
      await page.getByTestId("handler-dialog-confirm").click();
      await expect(dialog).toBeHidden();
      const launchedWindow = page.getByTestId("window-html-viewer");
      await expect(launchedWindow).toBeVisible();
      // Close it — it overlaps the Event Viewer window and would otherwise
      // intercept the next click.
      await launchedWindow.getByRole("button", { name: "Close" }).click();
      await expect(launchedWindow).toBeHidden();

      // Second event of the same type should now resolve directly (default set).
      await page.getByTestId(`event-row-${second.id}`).click();
      await expect(dialog).toBeHidden();
      await expect(page.getByTestId("window-html-viewer")).toBeVisible();
    } finally {
      await markRead(page, first.id);
      await markRead(page, second.id);
      await clearPreference(page, type);
      await unregisterHandler(page, handlerA, "html-viewer");
      await unregisterHandler(page, handlerB, "html-viewer");
    }
  });

  test("US7: Configuration tab lists handlers; disabling a headless handler stops it from blocking completion", async ({ page }) => {
    const ownerId = `e2e-core-${uniqueSuffix()}`;
    const type = `com.bos.${ownerId}.configurable.thing`;
    const handlerId = `handler-${uniqueSuffix()}`;
    await page.request.post("/api/events/register", {
      data: { handlerId, eventType: type, mode: "headless", ownerId, displayName: "E2E Configurable Handler", declaredBy: "core" },
    });
    try {
      await openEventViewer(page);
      await page.getByRole("button", { name: "Configuration" }).click();
      await expect(page.getByTestId(`config-group-${type}`)).toBeVisible();

      const toggle = page.getByTestId(`toggle-${handlerId}`);
      await toggle.click(); // disable

      await expect
        .poll(async () => {
          const groups = await page.request.get("/api/events/handlers").then((r) => r.json());
          return groups[type]?.headless?.find((h: { handlerId: string }) => h.handlerId === handlerId)?.enabled;
        })
        .toBe(false);

      // A disabled handler is not active — a new event of this type must be
      // immediately processed, not stuck pending on the disabled handler.
      const emitted = await emitTestEvent(page, type, "E2E disabled-handler test");
      try {
        const full = await page.request.get(`/api/events/${encodeURIComponent(emitted.id)}`).then((r) => r.json());
        expect(full.processing).toBe("processed");
      } finally {
        await markRead(page, emitted.id);
      }

      await toggle.click(); // re-enable
      await expect
        .poll(async () => {
          const groups = await page.request.get("/api/events/handlers").then((r) => r.json());
          return groups[type]?.headless?.find((h: { handlerId: string }) => h.handlerId === handlerId)?.enabled;
        })
        .toBe(true);
    } finally {
      await unregisterHandler(page, handlerId, ownerId);
    }
  });
});
