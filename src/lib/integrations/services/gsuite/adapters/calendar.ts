import "server-only";
import { ServiceAdapter } from "../../../adapters/base";
import { getService } from "../../../registry";
import { IntegrationConfigError } from "../../../errors";
import type { IntegrationEvent, ServiceDefinition } from "../../../types";
import type { AdapterMethodMeta } from "../../../actions/types";
import { gsuiteFetch, buildUrl } from "../client";
import { CALENDAR_SCOPES } from "../manifest";
import { CALENDAR_METHOD_DESCRIPTORS, type CalendarMethodName } from "./calendar-methods";
import { registerAdapter, getAdapterEntry } from "../../../actions/adapter-registry";

// CalendarAdapter — read + write surface for Google Calendar. Mirrors the
// GmailAdapter / DriveAdapter shape: every public method is scope-gated via
// `withScope`, all HTTP goes through `gsuiteFetch`, and return values are
// plain JSON that the CopilotKit dispatcher can pass through verbatim.

const BASE = "https://www.googleapis.com/calendar/v3";
const DEFAULT_CALENDAR = "primary";

// --- Types ---------------------------------------------------------------

export interface CalendarListEntry {
  id: string;
  summary?: string;
  description?: string;
  primary?: boolean;
  accessRole?: string;
  backgroundColor?: string;
  foregroundColor?: string;
  hidden?: boolean;
}
export interface ListCalendarsParams {
  maxResults?: number;
  pageToken?: string;
  showHidden?: boolean;
}
export interface ListCalendarsResult {
  items: CalendarListEntry[];
  nextPageToken?: string;
}

export interface EventDateTime {
  date?: string;
  dateTime?: string;
  timeZone?: string;
}
export interface EventAttendee {
  email: string;
  displayName?: string;
  responseStatus?: "needsAction" | "declined" | "tentative" | "accepted";
  self?: boolean;
  organizer?: boolean;
}
export interface CalendarEvent {
  id: string;
  status?: string;
  htmlLink?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: EventDateTime;
  end?: EventDateTime;
  attendees?: EventAttendee[];
  organizer?: { email?: string; displayName?: string; self?: boolean };
  created?: string;
  updated?: string;
  recurringEventId?: string;
}

export interface ListEventsParams {
  calendarId?: string;
  timeMin?: string;
  timeMax?: string;
  q?: string;
  maxResults?: number;
  pageToken?: string;
  singleEvents?: boolean;
  orderBy?: "startTime" | "updated";
}
export interface ListEventsResult {
  items: CalendarEvent[];
  nextPageToken?: string;
  timeZone?: string;
}

export interface GetEventParams {
  calendarId?: string;
  eventId: string;
}

export type SendUpdates = "all" | "externalOnly" | "none";

export interface CreateEventParams {
  calendarId?: string;
  summary: string;
  start: string;
  end: string;
  timeZone?: string;
  description?: string;
  location?: string;
  attendees?: string[];
  sendUpdates?: SendUpdates;
}

export interface UpdateEventParams {
  calendarId?: string;
  eventId: string;
  summary?: string;
  start?: string;
  end?: string;
  timeZone?: string;
  description?: string;
  location?: string;
  attendees?: string[];
  sendUpdates?: SendUpdates;
}

export interface DeleteEventParams {
  calendarId?: string;
  eventId: string;
  sendUpdates?: SendUpdates;
}

export interface RespondEventParams {
  calendarId?: string;
  eventId: string;
  responseStatus: "accepted" | "declined" | "tentative" | "needsAction";
  sendUpdates?: SendUpdates;
}

export interface MoveEventParams {
  calendarId?: string;
  eventId: string;
  destination: string;
  sendUpdates?: SendUpdates;
}

export interface FreeBusyParams {
  timeMin: string;
  timeMax: string;
  calendarIds?: string[];
  timeZone?: string;
}
export interface FreeBusyBusyRange {
  start: string;
  end: string;
}
export interface FreeBusyResult {
  timeMin: string;
  timeMax: string;
  calendars: Record<string, { busy: FreeBusyBusyRange[]; errors?: unknown[] }>;
}

// --- Helpers -------------------------------------------------------------

function serviceDef(): ServiceDefinition {
  const svc = getService("gsuite", "calendar");
  if (!svc) {
    throw new IntegrationConfigError("Calendar service is not registered on the gsuite integration.", {
      integrationId: "gsuite",
    });
  }
  return svc;
}

function isAllDay(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function toEventDateTime(value: string, timeZone?: string): EventDateTime {
  if (isAllDay(value)) return { date: value };
  return timeZone ? { dateTime: value, timeZone } : { dateTime: value };
}

// --- Adapter -------------------------------------------------------------

export class CalendarAdapter extends ServiceAdapter {
  constructor() {
    super("gsuite", serviceDef());
  }

  async listCalendars(params: ListCalendarsParams = {}): Promise<ListCalendarsResult> {
    return this.withScope(CALENDAR_SCOPES.readonly, async () => {
      const url = buildUrl(BASE, "/users/me/calendarList", {
        maxResults: params.maxResults,
        pageToken: params.pageToken,
        showHidden: params.showHidden,
      });
      const res = await gsuiteFetch<{ items?: CalendarListEntry[]; nextPageToken?: string }>(this, url);
      return { items: res.items ?? [], nextPageToken: res.nextPageToken };
    });
  }

  async listEvents(params: ListEventsParams = {}): Promise<ListEventsResult> {
    return this.withScope(CALENDAR_SCOPES.readonly, async () => {
      const calendarId = params.calendarId ?? DEFAULT_CALENDAR;
      const url = buildUrl(BASE, `/calendars/${encodeURIComponent(calendarId)}/events`, {
        timeMin: params.timeMin,
        timeMax: params.timeMax,
        q: params.q,
        maxResults: params.maxResults,
        pageToken: params.pageToken,
        singleEvents: params.singleEvents,
        orderBy: params.orderBy,
      });
      const res = await gsuiteFetch<{
        items?: CalendarEvent[];
        nextPageToken?: string;
        timeZone?: string;
      }>(this, url);
      return {
        items: res.items ?? [],
        nextPageToken: res.nextPageToken,
        timeZone: res.timeZone,
      };
    });
  }

  async getEvent(params: GetEventParams): Promise<CalendarEvent> {
    return this.withScope(CALENDAR_SCOPES.readonly, async () => {
      const calendarId = params.calendarId ?? DEFAULT_CALENDAR;
      const url = buildUrl(BASE, `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(params.eventId)}`);
      return gsuiteFetch<CalendarEvent>(this, url);
    });
  }

  async createEvent(params: CreateEventParams): Promise<CalendarEvent> {
    return this.withScope(CALENDAR_SCOPES.events, async () => {
      const calendarId = params.calendarId ?? DEFAULT_CALENDAR;
      const url = buildUrl(BASE, `/calendars/${encodeURIComponent(calendarId)}/events`, {
        sendUpdates: params.sendUpdates,
      });
      const body: Record<string, unknown> = {
        summary: params.summary,
        start: toEventDateTime(params.start, params.timeZone),
        end: toEventDateTime(params.end, params.timeZone),
      };
      if (params.description !== undefined) body.description = params.description;
      if (params.location !== undefined) body.location = params.location;
      if (params.attendees && params.attendees.length > 0) {
        body.attendees = params.attendees.map((email) => ({ email }));
      }
      return gsuiteFetch<CalendarEvent>(this, url, {
        method: "POST",
        body: JSON.stringify(body),
      });
    });
  }

  async updateEvent(params: UpdateEventParams): Promise<CalendarEvent> {
    return this.withScope(CALENDAR_SCOPES.events, async () => {
      const calendarId = params.calendarId ?? DEFAULT_CALENDAR;
      const url = buildUrl(BASE, `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(params.eventId)}`, {
        sendUpdates: params.sendUpdates,
      });
      const body: Record<string, unknown> = {};
      if (params.summary !== undefined) body.summary = params.summary;
      if (params.description !== undefined) body.description = params.description;
      if (params.location !== undefined) body.location = params.location;
      if (params.start !== undefined) body.start = toEventDateTime(params.start, params.timeZone);
      if (params.end !== undefined) body.end = toEventDateTime(params.end, params.timeZone);
      if (params.attendees !== undefined) {
        body.attendees = params.attendees.map((email) => ({ email }));
      }
      // PATCH performs a partial update — only the supplied fields are changed.
      return gsuiteFetch<CalendarEvent>(this, url, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
    });
  }

  async deleteEvent(params: DeleteEventParams): Promise<{ ok: true }> {
    return this.withScope(CALENDAR_SCOPES.events, async () => {
      const calendarId = params.calendarId ?? DEFAULT_CALENDAR;
      const url = buildUrl(BASE, `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(params.eventId)}`, {
        sendUpdates: params.sendUpdates,
      });
      await gsuiteFetch<void>(this, url, { method: "DELETE" });
      return { ok: true as const };
    });
  }

  async respondEvent(params: RespondEventParams): Promise<CalendarEvent> {
    return this.withScope(CALENDAR_SCOPES.events, async () => {
      const calendarId = params.calendarId ?? DEFAULT_CALENDAR;
      const eventUrl = buildUrl(BASE, `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(params.eventId)}`);
      // Fetch the event to find the current user's attendee entry, then flip
      // its responseStatus. Google's API doesn't expose a direct RSVP endpoint,
      // so we round-trip the attendees array.
      const event = await gsuiteFetch<CalendarEvent>(this, eventUrl);
      const attendees = (event.attendees ?? []).map((a) =>
        a.self ? { ...a, responseStatus: params.responseStatus } : a,
      );
      // If the caller isn't already on the attendee list (rare — happens when
      // the event was created without them but they can still respond), we
      // don't have their email; leave the array unchanged in that case.
      const patchUrl = buildUrl(BASE, `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(params.eventId)}`, {
        sendUpdates: params.sendUpdates,
      });
      return gsuiteFetch<CalendarEvent>(this, patchUrl, {
        method: "PATCH",
        body: JSON.stringify({ attendees }),
      });
    });
  }

  async moveEvent(params: MoveEventParams): Promise<CalendarEvent> {
    return this.withScope(CALENDAR_SCOPES.events, async () => {
      const calendarId = params.calendarId ?? DEFAULT_CALENDAR;
      const url = buildUrl(BASE, `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(params.eventId)}/move`, {
        destination: params.destination,
        sendUpdates: params.sendUpdates,
      });
      return gsuiteFetch<CalendarEvent>(this, url, { method: "POST" });
    });
  }

  async freebusyQuery(params: FreeBusyParams): Promise<FreeBusyResult> {
    return this.withScope(CALENDAR_SCOPES.readonly, async () => {
      const url = buildUrl(BASE, "/freeBusy");
      const items = (params.calendarIds ?? [DEFAULT_CALENDAR]).map((id) => ({ id }));
      const body: Record<string, unknown> = {
        timeMin: params.timeMin,
        timeMax: params.timeMax,
        items,
      };
      if (params.timeZone) body.timeZone = params.timeZone;
      return gsuiteFetch<FreeBusyResult>(this, url, {
        method: "POST",
        body: JSON.stringify(body),
      });
    });
  }

  /**
   * Legacy hook for the reminders poll job. Returns [] — reminder wiring is
   * still deferred; the scheduler daemon can register a job that calls this
   * without side effects. Keep the signature so `scheduler/jobs.ts` continues
   * to compile.
   */
  async pollUpcomingReminders(): Promise<IntegrationEvent[]> {
    return [];
  }
}

// --- Method metadata -----------------------------------------------------

const CALENDAR_INVOKERS: Record<
  CalendarMethodName,
  (adapter: CalendarAdapter, args: Record<string, unknown>) => Promise<unknown>
> = {
  calendars_list: (adapter, args) =>
    adapter.listCalendars({
      maxResults: args.maxResults as number | undefined,
      pageToken: args.pageToken as string | undefined,
      showHidden: args.showHidden as boolean | undefined,
    }),
  events_list: (adapter, args) =>
    adapter.listEvents({
      calendarId: args.calendarId as string | undefined,
      timeMin: args.timeMin as string | undefined,
      timeMax: args.timeMax as string | undefined,
      q: args.q as string | undefined,
      maxResults: args.maxResults as number | undefined,
      pageToken: args.pageToken as string | undefined,
      singleEvents: args.singleEvents as boolean | undefined,
      orderBy: args.orderBy as "startTime" | "updated" | undefined,
    }),
  events_get: (adapter, args) =>
    adapter.getEvent({
      calendarId: args.calendarId as string | undefined,
      eventId: String(args.eventId),
    }),
  events_create: (adapter, args) =>
    adapter.createEvent({
      calendarId: args.calendarId as string | undefined,
      summary: String(args.summary),
      start: String(args.start),
      end: String(args.end),
      timeZone: args.timeZone as string | undefined,
      description: args.description as string | undefined,
      location: args.location as string | undefined,
      attendees: args.attendees as string[] | undefined,
      sendUpdates: args.sendUpdates as SendUpdates | undefined,
    }),
  events_update: (adapter, args) =>
    adapter.updateEvent({
      calendarId: args.calendarId as string | undefined,
      eventId: String(args.eventId),
      summary: args.summary as string | undefined,
      start: args.start as string | undefined,
      end: args.end as string | undefined,
      timeZone: args.timeZone as string | undefined,
      description: args.description as string | undefined,
      location: args.location as string | undefined,
      attendees: args.attendees as string[] | undefined,
      sendUpdates: args.sendUpdates as SendUpdates | undefined,
    }),
  events_delete: (adapter, args) =>
    adapter.deleteEvent({
      calendarId: args.calendarId as string | undefined,
      eventId: String(args.eventId),
      sendUpdates: args.sendUpdates as SendUpdates | undefined,
    }),
  events_respond: (adapter, args) =>
    adapter.respondEvent({
      calendarId: args.calendarId as string | undefined,
      eventId: String(args.eventId),
      responseStatus: String(args.responseStatus) as RespondEventParams["responseStatus"],
      sendUpdates: args.sendUpdates as SendUpdates | undefined,
    }),
  events_move: (adapter, args) =>
    adapter.moveEvent({
      calendarId: args.calendarId as string | undefined,
      eventId: String(args.eventId),
      destination: String(args.destination),
      sendUpdates: args.sendUpdates as SendUpdates | undefined,
    }),
  freebusy_query: (adapter, args) =>
    adapter.freebusyQuery({
      timeMin: String(args.timeMin),
      timeMax: String(args.timeMax),
      calendarIds: args.calendarIds as string[] | undefined,
      timeZone: args.timeZone as string | undefined,
    }),
};

export const CALENDAR_METHODS: readonly AdapterMethodMeta<CalendarAdapter>[] =
  CALENDAR_METHOD_DESCRIPTORS.map((d) => ({
    method: d.method,
    scope: d.scope,
    description: d.description,
    parameters: d.parameters,
    invoke: CALENDAR_INVOKERS[d.method],
  }));

export type { CalendarMethodName } from "./calendar-methods";

// --- Registration --------------------------------------------------------
if (!getAdapterEntry("gsuite", "calendar")) {
  registerAdapter("gsuite", "calendar", {
    createAdapter: () => new CalendarAdapter(),
    methods: CALENDAR_METHODS,
  });
}
