import { NextRequest, NextResponse } from "next/server";
import "@/lib/integrations"; // side-effect: register manifests
import { emitNotification } from "@/lib/integrations/notifications/store";
import { getService } from "@/lib/integrations/registry";
import { readWebhookConfig } from "@/lib/integrations/webhooks/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST /api/integrations/[id]/services/[serviceId]/webhook/test
//
// "Test webhook" button in the settings UI. Instead of round-tripping through
// the receiver (which would require the caller to sign the payload with the
// current secret / mint a Google JWT), we synthesise a `IntegrationEvent`
// directly and drop it into the notifications inbox. This exercises the
// downstream half of the pipeline (event → inbox → badge) without requiring
// the user to configure a real provider push.
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; serviceId: string }> },
) {
  const { id, serviceId } = await params;
  const svc = getService(id, serviceId);
  if (!svc) return NextResponse.json({ error: `Unknown service: ${id}/${serviceId}` }, { status: 404 });

  const config = await readWebhookConfig(id, serviceId);
  if (!config) return NextResponse.json({ error: "webhook not configured" }, { status: 400 });

  await emitNotification({
    type: "webhook_test",
    service: `${id}/${serviceId}`,
    timestamp: Date.now(),
    data: {
      note: "Test event emitted from Settings → Integrations → Webhook → Test.",
    },
  });
  return NextResponse.json({ ok: true });
}
