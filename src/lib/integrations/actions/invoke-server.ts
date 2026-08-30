import "server-only";
import "@/lib/integrations"; // side-effect: register manifests + adapters
import { getService } from "@/lib/integrations/registry";
import { getAdapterEntry, getAdapterMethod } from "@/lib/integrations/actions/adapter-registry";

// In-process counterpart to `/api/integrations/[id]/services/[serviceId]/invoke`,
// for callers (src/lib/assistant/tools/server/integrations.ts) that already run
// inside the same Node process as that route. dispatcher.ts's `invokeAdapterMethod`
// reaches it over a loopback `fetch("/api/...")` with a relative URL, which only
// resolves inside an active Next.js request context (the browser, or a route
// handler) — a scheduled/cron-triggered server-tool run has no such context, so
// that fetch throws `TypeError: Failed to parse URL from /api/integrations/...`.
// This mirrors the route's lookup + invoke logic without the HTTP hop or the
// request-context dependency; thrown errors are the real IntegrationError
// subclasses (not re-parsed from a JSON body), which already carry the
// `.code`/`.scope`/`.integrationId` fields the tool wrapper's mapError() reads.
export async function invokeAdapterMethodDirect(input: {
  integrationId: string;
  serviceId: string;
  method: string;
  args: Record<string, unknown>;
}): Promise<unknown> {
  const svc = getService(input.integrationId, input.serviceId);
  if (!svc) throw new Error(`Unknown service: ${input.integrationId}/${input.serviceId}`);

  const entry = getAdapterEntry(input.integrationId, input.serviceId);
  if (!entry) throw new Error(`No adapter registered for ${input.integrationId}/${input.serviceId}`);

  const meta = getAdapterMethod(input.integrationId, input.serviceId, input.method);
  if (!meta) throw new Error(`Unknown method: ${input.method}`);

  const adapter = entry.createAdapter();
  return meta.invoke(adapter, input.args);
}
