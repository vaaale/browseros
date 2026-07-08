import { NextRequest, NextResponse } from "next/server";
import "@/lib/integrations"; // side-effect: register manifests
import { getService } from "@/lib/integrations/registry";
import { getAdapterEntry } from "@/lib/integrations/actions/adapter-registry";
import { emitNotification } from "@/lib/integrations/notifications/store";
import { mutateState } from "@/lib/integrations/state/store";
import { ensureSchedulerStarted } from "@/lib/integrations/scheduler/daemon";
import { runJobOnce } from "@/lib/integrations/scheduler/jobs";
import {
  IntegrationAuthError,
  IntegrationConfigError,
  IntegrationError,
  IntegrationScopeError,
} from "@/lib/integrations/errors";
import type { GmailAdapter } from "@/lib/integrations/services/gsuite/adapters/gmail";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST /api/integrations/[id]/services/[serviceId]/poll
//
// Manual "poll now" trigger. Two paths:
//   - No body / empty body → delegate to the shared `runJobOnce` helper so the
//     same backoff/state discipline the daemon uses applies (recommended).
//   - Explicit { since, maxResults } → bypass the shared helper and pass those
//     through directly. This is the "test poll" path for the settings UI where
//     the user wants to override `since` for debugging.
//
// The route also lazy-starts the daemon so a user who only interacts via
// "Poll now" still ends up with automatic polling if they enable it later.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; serviceId: string }> },
) {
  const { id, serviceId } = await params;

  ensureSchedulerStarted();

  const svc = getService(id, serviceId);
  if (!svc) {
    return NextResponse.json(
      { error: { code: "unknown_service", message: `Unknown service: ${id}/${serviceId}` } },
      { status: 404 },
    );
  }
  const entry = getAdapterEntry(id, serviceId);
  if (!entry) {
    return NextResponse.json(
      { error: { code: "no_adapter", message: `No adapter for ${id}/${serviceId}` } },
      { status: 404 },
    );
  }

  let body: { since?: number; maxResults?: number } = {};
  try {
    body = ((await req.json().catch(() => ({}))) as typeof body) ?? {};
  } catch {
    body = {};
  }

  // Shared-path: no overrides → use runJobOnce to keep backoff bookkeeping
  // consistent between the daemon and manual triggers.
  if (body.since === undefined && body.maxResults === undefined) {
    const result = await runJobOnce(id, serviceId);
    if (result.ok) {
      return NextResponse.json({ newMessages: result.newMessages ?? 0, emitted: result.newMessages ?? 0 });
    }
    return NextResponse.json(
      { error: { code: "poll_failed", message: result.error ?? "poll failed" } },
      { status: 500 },
    );
  }

  // Advanced-path: honour the caller's overrides. Errors here don't update
  // backoff (this is an ad-hoc developer probe, not a scheduled poll).
  const adapter = entry.createAdapter();
  const pollable = adapter as unknown as { pollOnce?: GmailAdapter["pollOnce"] };
  if (typeof pollable.pollOnce !== "function") {
    return NextResponse.json(
      { error: { code: "not_pollable", message: `${id}/${serviceId} does not support polling.` } },
      { status: 400 },
    );
  }
  try {
    const result = await pollable.pollOnce({ since: body.since, maxResults: body.maxResults });
    let emitted = 0;
    for (const ev of result.events) {
      await emitNotification(ev);
      emitted++;
    }
    await mutateState(id, (prev) => ({
      ...prev,
      services: {
        ...prev.services,
        [serviceId]: {
          ...(prev.services[serviceId] ?? { enabled: false, config: {} }),
          lastSync: Date.now(),
          error: undefined,
        },
      },
    })).catch(() => {});
    return NextResponse.json({ newMessages: result.newMessages, emitted });
  } catch (err) {
    await mutateState(id, (prev) => ({
      ...prev,
      services: {
        ...prev.services,
        [serviceId]: {
          ...(prev.services[serviceId] ?? { enabled: false, config: {} }),
          error: (err as Error).message ?? "poll failed",
        },
      },
    })).catch(() => {});

    if (err instanceof IntegrationScopeError) {
      return NextResponse.json(
        { error: { code: err.code, message: err.message, scope: err.scope, integrationId: err.integrationId } },
        { status: 403 },
      );
    }
    if (err instanceof IntegrationAuthError) {
      return NextResponse.json(
        { error: { code: err.code, message: err.message, integrationId: err.integrationId } },
        { status: 401 },
      );
    }
    if (err instanceof IntegrationConfigError) {
      return NextResponse.json(
        { error: { code: err.code, message: err.message, integrationId: err.integrationId } },
        { status: 400 },
      );
    }
    if (err instanceof IntegrationError) {
      return NextResponse.json(
        { error: { code: err.code, message: err.message, integrationId: err.integrationId } },
        { status: 500 },
      );
    }
    return NextResponse.json(
      { error: { code: "internal", message: (err as Error).message ?? "poll failed" } },
      { status: 500 },
    );
  }
}
