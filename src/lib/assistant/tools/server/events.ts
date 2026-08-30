import "server-only";
import type { AssistantTool } from "../../tools";
import { serverTool, schema, p } from "./util";
import * as api from "@/lib/events/api";
import { EventApiError } from "@/lib/events/types";

// Agent tools for the public event API (034-event-notification-system,
// FR-001/contracts/event-api.md "Agent-tool mapping"). Same contract as the
// HTTP routes — in-process, no HTTP hop, exactly the integrations.ts/
// scheduler.ts pattern. The assistant emits/acks/registers as component id
// "assistant" (SOURCES.assistant in the mockup).

const ASSISTANT_ID = "assistant";
const ASSISTANT_SOURCE = { appId: ASSISTANT_ID, name: "Assistant" };

function describeError(err: unknown): string {
  if (err instanceof EventApiError) return `${err.code}: ${err.message}`;
  return (err as Error).message ?? String(err);
}

export function eventsTools(): Record<string, AssistantTool> {
  return {
    emit_event: serverTool(
      "emit_event",
      "Publish an event onto BOS's event bus (type + JSON payload, max 1MB). Durably recorded before returning; dispatched to any matching headless handlers asynchronously.",
      schema(
        {
          type: p.str('Dot-separated namespaced event type, e.g. "com.bos.assistant.task.done".'),
          payload: p.obj("JSON payload (object). Include an optional `summary` string field for the list view."),
        },
        ["type", "payload"],
      ),
      async (input) => {
        try {
          const result = await api.emit({
            type: String(input.type),
            payload: (input.payload as Record<string, unknown>) ?? {},
            source: ASSISTANT_SOURCE,
          });
          return JSON.stringify(result);
        } catch (err) {
          return `Error: ${describeError(err)}`;
        }
      },
    ),

    query_events: serverTool(
      "query_events",
      "List events (summaries), optionally filtered by type, processing status, read state, or time range. Powers triage/inspection.",
      schema({
        type: p.str("Event type or namespace prefix filter."),
        status: p.str('Processing status filter: "pending" | "processed".'),
        read: p.str('Read state filter: "unread" | "read".'),
        from: p.num("Epoch ms lower bound on timestamp."),
        to: p.num("Epoch ms upper bound on timestamp."),
        cursor: p.str("Opaque pagination cursor from a previous call's nextCursor."),
        limit: p.num("Page size, default 50, max 200."),
      }),
      async (input) => {
        const result = api.query({
          type: typeof input.type === "string" ? input.type : undefined,
          status: input.status === "pending" || input.status === "processed" ? input.status : undefined,
          read: input.read === "unread" || input.read === "read" ? input.read : undefined,
          from: typeof input.from === "number" ? input.from : undefined,
          to: typeof input.to === "number" ? input.to : undefined,
          cursor: typeof input.cursor === "string" ? input.cursor : undefined,
          limit: typeof input.limit === "number" ? input.limit : undefined,
        });
        return JSON.stringify(result);
      },
    ),

    get_event: serverTool(
      "get_event",
      "Fetch one event's full record: payload, processing status, and complete handler acknowledgment history.",
      schema({ eventId: p.str("The event id.") }, ["eventId"]),
      async (input) => {
        try {
          const event = await api.getEvent(String(input.eventId));
          return JSON.stringify(event);
        } catch (err) {
          return `Error: ${describeError(err)}`;
        }
      },
    ),

    ack_event: serverTool(
      "ack_event",
      "Acknowledge an event on behalf of a headless handler the assistant owns, with an optional result payload. Fails if the assistant does not own the handler (FR-022).",
      schema(
        {
          eventId: p.str("The event id to acknowledge."),
          handlerId: p.str("The handler id (must be owned by the assistant)."),
          result: p.obj("Optional result payload to store on the event."),
        },
        ["eventId", "handlerId"],
      ),
      async (input) => {
        try {
          const result = api.ack(String(input.eventId), {
            handlerId: String(input.handlerId),
            result: input.result,
            callerId: ASSISTANT_ID,
          });
          return JSON.stringify(result);
        } catch (err) {
          return `Error: ${describeError(err)}`;
        }
      },
    ),

    mark_events_read: serverTool(
      "mark_events_read",
      "Mark one event as read, or all unread events as read.",
      schema({
        eventId: p.str("The event id to mark read. Omit and set all=true to mark every unread event read."),
        all: p.bool("Mark ALL unread events as read instead of a single event."),
      }),
      async (input) => {
        try {
          if (input.all === true) return JSON.stringify(api.markAllRead());
          if (typeof input.eventId !== "string" || !input.eventId) return "Error: provide eventId, or set all=true.";
          return JSON.stringify(api.markRead(input.eventId));
        } catch (err) {
          return `Error: ${describeError(err)}`;
        }
      },
    ),

    set_event_preference: serverTool(
      "set_event_preference",
      'Set (or clear, by omitting preferredHandlerId) the default UI handler for an event type — "Always use this app for this event type".',
      schema(
        {
          eventType: p.str("The event type to set a default handler for."),
          preferredHandlerId: p.str("A UI-mode handler id registered for that type. Omit to clear the preference."),
        },
        ["eventType"],
      ),
      async (input) => {
        try {
          const pref = await api.setPreference(
            String(input.eventType),
            typeof input.preferredHandlerId === "string" ? input.preferredHandlerId : null,
          );
          return JSON.stringify({ eventType: input.eventType, preferredHandlerId: pref?.preferredHandlerId ?? null });
        } catch (err) {
          return `Error: ${describeError(err)}`;
        }
      },
    ),

    list_event_handlers: serverTool(
      "list_event_handlers",
      "List every registered event handler (headless + UI), grouped by event type, with enabled state and recent failure counts.",
      schema({}),
      async () => JSON.stringify(api.listHandlersGrouped()),
    ),
  };
}
