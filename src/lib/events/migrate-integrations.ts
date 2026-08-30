import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { dataDir } from "@/os/data-dir";
import { initStore, appendMigratedEvent, getStoreRoot } from "./store";
import { deriveSummary } from "./types";
import { deriveLegacyType, legacySourceFor, legacyFriendlySummary } from "./legacy-mapping";
import type { IntegrationEvent } from "@/lib/integrations/types";

// One-time, idempotent migration of the legacy GSuite/Telegram notification
// inbox (data/integrations/notifications.json) onto the event kernel
// (design.md §3.8, R6). Runs from instrumentation.ts BEFORE startEventKernel()
// so the kernel's first dispatch cycle already sees migrated events. Guarded
// by a marker file so it runs at most once; a partial failure leaves the
// marker absent and the migration retries on the next boot — safe because
// migrated events use a stable derived id (`legacy-<originalIndex>`, R6) that
// simply no-ops on re-encountering an id already in the index.
//
// This module reads the legacy file DIRECTLY rather than importing
// src/lib/integrations/notifications/store.ts — that module (its write API,
// `emitNotification`) has been retired (T031) now that every emitter is
// re-pointed at api.emit; only this one transient read of the historical
// file remains, until every real deployment has migrated once.

interface StoredNotification {
  id: number;
  event: IntegrationEvent;
  read: boolean;
}

function legacyNotificationsFile(): string {
  return path.join(dataDir(), "integrations", "notifications.json");
}

async function readLegacyNotifications(): Promise<StoredNotification[]> {
  try {
    const raw = await fs.readFile(legacyNotificationsFile(), "utf8");
    const parsed = JSON.parse(raw) as { items?: StoredNotification[] };
    return Array.isArray(parsed.items) ? parsed.items : [];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

function markerPath(): string {
  return path.join(getStoreRoot(), ".migrated-integrations");
}

async function fileExists(p: string): Promise<boolean> {
  return fs
    .access(p)
    .then(() => true)
    .catch(() => false);
}

export async function migrateIntegrationsToEvents(): Promise<void> {
  await initStore();
  if (await fileExists(markerPath())) return;

  const items = await readLegacyNotifications();
  for (const item of items) {
    const type = deriveLegacyType(item.event.service, item.event.type);
    const source = legacySourceFor(item.event.service);
    const payload = { ...item.event.data, _legacyType: item.event.type, _legacyService: item.event.service };
    const summary = legacyFriendlySummary(item.event.service, item.event.type, item.event.data) ?? deriveSummary(payload);
    await appendMigratedEvent({
      id: `legacy-${item.id}`,
      type,
      payload,
      source,
      summary,
      ts: item.event.timestamp,
      read: item.read ? "read" : "unread",
    });
  }

  await fs.mkdir(path.dirname(markerPath()), { recursive: true });
  await fs.writeFile(markerPath(), JSON.stringify({ migratedAt: Date.now(), count: items.length }));
}
