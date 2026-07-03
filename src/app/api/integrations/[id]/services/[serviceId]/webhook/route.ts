import { NextRequest, NextResponse } from "next/server";
import "@/lib/integrations"; // side-effect: register manifests
import { getService } from "@/lib/integrations/registry";
import {
  deleteWebhook,
  disableWebhook,
  enableWebhook,
  getSnapshot,
  rotateSecret,
} from "@/lib/integrations/webhooks/manager";
import type { WebhookConfig } from "@/lib/integrations/webhooks/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Webhook management for a single service.
//
// GET  → snapshot: current config + hasSecret + receiver URL.
// POST → { action: "enable" | "disable" | "rotate" | "delete", patch? }
//        - enable[, patch]: writes patch into config, mints secret if needed,
//          calls handler.onEnable (may hit provider — e.g. gmail.users.watch).
//        - disable: flips enabled=false and calls handler.onDisable.
//        - rotate: mints a new primary secret, returns it once (only time the
//          plaintext leaves the server) so the user can paste it into the
//          provider. Existing subscriptions still verify against the demoted
//          previous secret during the rotation window.
//        - delete: full teardown (disable + delete secrets).
// PATCH → merge a partial WebhookConfig into the stored config (used by the
//         UI for editing event types / labels without touching enable state).

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; serviceId: string }> },
) {
  const { id, serviceId } = await params;
  const svc = getService(id, serviceId);
  if (!svc) return NextResponse.json({ error: `Unknown service: ${id}/${serviceId}` }, { status: 404 });
  const snapshot = await getSnapshot(id, serviceId);
  return NextResponse.json(snapshot);
}

interface PostBody {
  action: "enable" | "disable" | "rotate" | "delete";
  patch?: Partial<WebhookConfig>;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; serviceId: string }> },
) {
  const { id, serviceId } = await params;
  const svc = getService(id, serviceId);
  if (!svc) return NextResponse.json({ error: `Unknown service: ${id}/${serviceId}` }, { status: 404 });

  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  try {
    switch (body.action) {
      case "enable": {
        const snapshot = await enableWebhook({
          integrationId: id,
          serviceId,
          patch: body.patch,
        });
        return NextResponse.json(snapshot);
      }
      case "disable": {
        const snapshot = await disableWebhook({ integrationId: id, serviceId });
        return NextResponse.json(snapshot);
      }
      case "rotate": {
        const { secrets, snapshot } = await rotateSecret({ integrationId: id, serviceId });
        // We reveal the plaintext primary ONCE here — the user needs it to
        // paste into their provider. Subsequent GETs report `hasSecret: true`
        // but never leak it.
        return NextResponse.json({ ...snapshot, primary: secrets.primary });
      }
      case "delete": {
        await deleteWebhook({ integrationId: id, serviceId });
        const snapshot = await getSnapshot(id, serviceId);
        return NextResponse.json(snapshot);
      }
      default:
        return NextResponse.json({ error: `unknown action: ${String(body.action)}` }, { status: 400 });
    }
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message ?? "webhook action failed" },
      { status: 500 },
    );
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; serviceId: string }> },
) {
  const { id, serviceId } = await params;
  const svc = getService(id, serviceId);
  if (!svc) return NextResponse.json({ error: `Unknown service: ${id}/${serviceId}` }, { status: 404 });

  let body: Partial<WebhookConfig>;
  try {
    body = (await req.json()) as Partial<WebhookConfig>;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const { writeWebhookConfig } = await import("@/lib/integrations/webhooks/store");
  await writeWebhookConfig(id, serviceId, body);
  const snapshot = await getSnapshot(id, serviceId);
  return NextResponse.json(snapshot);
}
