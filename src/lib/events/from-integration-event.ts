import "server-only";
import * as api from "./api";
import { deriveSummary } from "./types";
import { deriveLegacyType, legacySourceFor, legacyFriendlySummary } from "./legacy-mapping";
import type { IntegrationEvent } from "@/lib/integrations/types";

// Re-points the legacy `emitNotification(event)` call sites onto the event
// kernel (design.md §3.8 "Re-point emitters"). Uses the same type/source
// derivation as the one-time migration so a live GSuite/Telegram event and
// its historical counterpart land under the same namespace.
export async function emitIntegrationEvent(event: IntegrationEvent): Promise<void> {
  const type = deriveLegacyType(event.service, event.type);
  const source = legacySourceFor(event.service);
  const payload = { ...event.data, _integrationType: event.type, _integrationService: event.service };
  const summary = legacyFriendlySummary(event.service, event.type, event.data) ?? deriveSummary(payload);
  await api.emit({ type, payload: { ...payload, summary }, source });
}
