// Shared "legacy IntegrationEvent → event kernel" mapping, used by both the
// one-time migration (migrate-integrations.ts) and the live re-pointed
// emitters (from-integration-event.ts). No "server-only" import — pure
// string logic, safe to import from either.

function slug(s: string): string {
  return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "x";
}

// Known legacy `service:type` pairs mapped onto the mockup's naming
// convention; anything else falls back to a systematic com.bos.<integration>.
// <service>.<type> derivation.
const KNOWN_TYPES: Record<string, string> = {
  "gsuite/gmail:new_email": "com.bos.gsuite.email.received",
  "gsuite/calendar:new_event": "com.bos.gsuite.calendar.event",
};

const KNOWN_NAMES: Record<string, string> = {
  gsuite: "GSuite",
  telegram: "Telegram",
};

export function deriveLegacyType(service: string, kind: string): string {
  const known = KNOWN_TYPES[`${service}:${kind}`];
  if (known) return known;
  const [integrationId, serviceId] = service.split("/");
  return `com.bos.${slug(integrationId || "integrations")}.${slug(serviceId || "service")}.${slug(kind || "event")}`;
}

export function legacySourceFor(service: string): { appId: string; name: string } {
  const [integrationId] = service.split("/");
  const appId = slug(integrationId || "integrations");
  return { appId, name: KNOWN_NAMES[appId] ?? appId };
}

/** A friendlier summary than the generic JSON-stringify fallback for the
 *  well-known shapes (Gmail/Telegram) — everything else falls through to
 *  deriveSummary()'s truncated-stringify default. */
export function legacyFriendlySummary(service: string, kind: string, data: Record<string, unknown>): string | undefined {
  if (service === "gsuite/gmail" && kind === "new_email") {
    const from = typeof data.from === "string" ? data.from : "unknown sender";
    const subject = typeof data.subject === "string" && data.subject ? data.subject : "(no subject)";
    return `${subject} — ${from}`;
  }
  if (service === "gsuite/calendar" && kind === "new_event") {
    const title = typeof data.summary === "string" ? data.summary : typeof data.title === "string" ? data.title : "New event";
    return title;
  }
  const message = (data as { message?: { text?: unknown; chat?: { title?: unknown } } }).message;
  if (service.startsWith("telegram") && message) {
    const text = typeof message.text === "string" ? message.text : "(no text)";
    const chatTitle = typeof message.chat?.title === "string" ? message.chat.title : undefined;
    return chatTitle ? `${chatTitle}: ${text}` : text;
  }
  return undefined;
}
