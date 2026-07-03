import { NextRequest, NextResponse } from "next/server";
import "@/lib/integrations"; // side-effect: register manifests
import { getService } from "@/lib/integrations/registry";
import { getAdapterEntry, getAdapterMethod } from "@/lib/integrations/actions/adapter-registry";
import {
  IntegrationAuthError,
  IntegrationConfigError,
  IntegrationError,
  IntegrationScopeError,
} from "@/lib/integrations/errors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface InvokeBody {
  method?: string;
  args?: Record<string, unknown>;
}

// POST /api/integrations/[id]/services/[serviceId]/invoke
//
// One endpoint the ASSISTANT calls (via `IntegrationActions.tsx` handlers) for
// every adapter method. Scope + auth checks live in the adapter's `withScope`,
// so this route is a thin marshalling layer:
//
//   1. Validate params + body shape.
//   2. Look up (integrationId, serviceId, method) via the adapter registry.
//   3. Call `meta.invoke(adapter, args)` and return `{ result }` on success.
//   4. Turn IntegrationError subclasses into structured `{ error }` payloads
//      so the LLM sees the same error contract regardless of the adapter.
//
// The client-side `available` flag on the CopilotKit action is presentation
// only — this route re-checks scopes as a defence-in-depth measure.
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
      { error: { code: "no_adapter", message: `No adapter registered for ${id}/${serviceId}` } },
      { status: 404 },
    );
  }

  let body: InvokeBody;
  try {
    body = (await req.json()) as InvokeBody;
  } catch {
    return NextResponse.json({ error: { code: "bad_request", message: "invalid JSON body" } }, { status: 400 });
  }
  const methodName = body.method;
  if (!methodName || typeof methodName !== "string") {
    return NextResponse.json(
      { error: { code: "bad_request", message: "missing `method` in request body" } },
      { status: 400 },
    );
  }
  const meta = getAdapterMethod(id, serviceId, methodName);
  if (!meta) {
    return NextResponse.json(
      { error: { code: "unknown_method", message: `Unknown method: ${methodName}` } },
      { status: 404 },
    );
  }
  const args = (body.args ?? {}) as Record<string, unknown>;

  try {
    const adapter = entry.createAdapter();
    const result = await meta.invoke(adapter, args);
    return NextResponse.json({ result });
  } catch (err) {
    if (err instanceof IntegrationScopeError) {
      return NextResponse.json(
        {
          error: {
            code: err.code,
            message: err.message,
            scope: err.scope,
            integrationId: err.integrationId,
          },
        },
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
      { error: { code: "internal", message: (err as Error).message ?? "internal error" } },
      { status: 500 },
    );
  }
}
