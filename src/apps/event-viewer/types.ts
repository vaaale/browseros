// Client-side mirrors of the `GET /api/events/handlers` response shape
// (contracts/event-api.md §9) — deliberately not imported from
// src/lib/events/kernel.ts (server-only): the HTTP response is the contract,
// not the kernel's internal types.

export interface HeadlessHandlerView {
  handlerId: string;
  displayName: string;
  icon?: string;
  enabled: boolean;
  timeoutMs: number;
  recentFailures: number;
  ownerId: string;
}

export interface UiHandlerView {
  handlerId: string;
  displayName: string;
  icon?: string;
  description?: string;
  isDefault: boolean;
  ownerId: string;
  launch?: { appId: string; componentHint?: string };
}

export interface HandlerGroup {
  headless: HeadlessHandlerView[];
  ui: UiHandlerView[];
}
