import "server-only";
import * as api from "./api";
import { BUILTIN_APPS } from "@/os/apps";
import type { AppManifest } from "@/os/types";

// Surfaces every app's statically-declared UI event handlers
// (AppManifest.eventHandlers) into the kernel registry at boot (FR-013,
// T037). Headless handlers are never declared here — they are runtime-
// declared by running services over worker IPC (ADR-3, handler_declare).
//
// handlerId is `${app.id}:${declaration.id}` — globally unique even though
// data-model.md describes handlerId as "unique within owner": a flat Map
// keyed by handlerId needs global uniqueness, and prefixing with the owner
// id achieves that without changing the per-owner uniqueness contract app
// authors actually see (they only pick `declaration.id`).
export async function registerAppUiHandlers(app: AppManifest): Promise<void> {
  if (!app.eventHandlers?.length) return;
  for (const h of app.eventHandlers) {
    try {
      await api.register({
        handlerId: `${app.id}:${h.id}`,
        eventType: h.type,
        mode: "ui",
        ownerId: app.id,
        displayName: h.displayName,
        description: h.description,
        icon: h.icon ?? app.icon,
        declaredBy: "manifest",
        launch: { appId: app.id },
        grantedNamespaces: app.eventNamespaces,
      });
    } catch (err) {
      console.error(`[events] failed to register UI handler "${h.id}" for app "${app.id}":`, (err as Error).message);
    }
  }
}

/** Called once at boot (instrumentation.ts, after startEventKernel()). Also
 *  safe to call again later (e.g. after installing a new app) — register()
 *  is an idempotent upsert. */
export async function registerAllUiHandlers(): Promise<void> {
  for (const app of BUILTIN_APPS) await registerAppUiHandlers(app);
  try {
    const { listInstalledManifests } = await import("@/lib/apps/store");
    const installed = await listInstalledManifests();
    for (const app of installed) await registerAppUiHandlers(app);
  } catch (err) {
    console.error("[events] failed to surface installed apps' UI handlers:", (err as Error).message);
  }
}
