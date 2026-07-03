import { NextRequest, NextResponse } from "next/server";
import "@/lib/integrations"; // side-effect: register manifests
import { getService } from "@/lib/integrations/registry";
import { getAdapterEntry } from "@/lib/integrations/actions/adapter-registry";
import { emitNotification } from "@/lib/integrations/notifications/store";
import { mutateState } from "@/lib/integrations/state/store";
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
// Manual polling trigger — Phase 1 stand-in for a scheduler (see spec.md §Roadmap).
// The service's adapter is asked to `pollOnce()`, and every returned event is
// forwarded to the notifications module. The route also touches `lastSync` on
// the service state so the Settings UI can show "last polled" without needing
// a separate metadata endpoint.
//
// Body (optional):
//   { since?: number, maxResults?: number }
//
// Response:
//   { newMessages: number, emitted: number }
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; serviceId: string }> },
) {
  const { id, serviceId } = await params;

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

  const adapter = entry.createAdapter();
  // Only Gmail exposes pollOnce in Phase 1. Guard by shape rather than by
  // adapter identity so future adapters that implement pollOnce work here for
  // free.
  const pollable = adapter as unknown as {
    pollOnce?: GmailAdapter["pollOnce"];
  };
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
    // Record the error on the service state so the Settings UI can surface it.
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
