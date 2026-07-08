// Framework-free method metadata for CalendarAdapter. Split out of
// calendar.ts (which is `server-only`) so the CLIENT dispatcher can walk this
// list to register CopilotKit actions without pulling in Node/Google APIs.
//
// The metadata here does NOT include the `invoke` closure — that lives with
// the adapter in calendar.ts and is only used server-side by the invoke route
// (see actions/adapter-registry.ts).
//
// Method ids follow the BOS `<object>_<verb>` snake_case tool-naming standard.

import { CALENDAR_SCOPES } from "../manifest";
import type { AdapterMethodParameter } from "../../../actions/types";

export type CalendarMethodName =
  | "calendars_list"
  | "events_list"
  | "events_get"
  | "events_create"
  | "events_update"
  | "events_delete"
  | "events_respond"
  | "events_move"
  | "freebusy_query";

export interface CalendarMethodDescriptor {
  method: CalendarMethodName;
  scope: string;
  description: string;
  parameters: AdapterMethodParameter[];
}

export const CALENDAR_METHOD_DESCRIPTORS: readonly CalendarMethodDescriptor[] = [
  {
    method: "calendars_list",
    scope: CALENDAR_SCOPES.readonly,
    description:
      "List the calendars on the authenticated user's calendar list (primary + subscribed). Returns id, summary, primary flag, accessRole.",
    parameters: [
      { name: "maxResults", type: "number", description: "Max results per page (default 100).", required: false },
      { name: "pageToken", type: "string", description: "Next page token from a previous call.", required: false },
      { name: "showHidden", type: "boolean", description: "Include hidden calendars.", required: false },
    ],
  },
  {
    method: "events_list",
    scope: CALENDAR_SCOPES.readonly,
    description:
      "List events on a calendar. Use `timeMin`/`timeMax` (RFC3339) to bound the window, `q` for free-text search, and `singleEvents=true` to expand recurring events into instances.",
    parameters: [
      { name: "calendarId", type: "string", description: "Calendar id ('primary' or a specific id).", required: false },
      { name: "timeMin", type: "string", description: "Lower bound (RFC3339, inclusive) on event end time.", required: false },
      { name: "timeMax", type: "string", description: "Upper bound (RFC3339, exclusive) on event start time.", required: false },
      { name: "q", type: "string", description: "Free-text search across summary/description/location/attendees.", required: false },
      { name: "maxResults", type: "number", description: "Max results per page (default 250, cap 2500).", required: false },
      { name: "pageToken", type: "string", description: "Next page token.", required: false },
      { name: "singleEvents", type: "boolean", description: "Expand recurring events into single instances.", required: false },
      { name: "orderBy", type: "string", description: "'startTime' | 'updated'. startTime requires singleEvents=true.", required: false },
    ],
  },
  {
    method: "events_get",
    scope: CALENDAR_SCOPES.readonly,
    description: "Fetch a single event by id from a calendar.",
    parameters: [
      { name: "calendarId", type: "string", description: "Calendar id (defaults to 'primary').", required: false },
      { name: "eventId", type: "string", description: "The event id.", required: true },
    ],
  },
  {
    method: "events_create",
    scope: CALENDAR_SCOPES.events,
    description:
      "Create a new event. `start` and `end` accept ISO datetime (with timezone) or an all-day 'YYYY-MM-DD' date. Attendees are optional.",
    parameters: [
      { name: "calendarId", type: "string", description: "Calendar id (defaults to 'primary').", required: false },
      { name: "summary", type: "string", description: "Event title.", required: true },
      { name: "start", type: "string", description: "Start (ISO datetime or 'YYYY-MM-DD' for all-day).", required: true },
      { name: "end", type: "string", description: "End (ISO datetime or 'YYYY-MM-DD' for all-day).", required: true },
      { name: "timeZone", type: "string", description: "IANA timezone (e.g. 'Europe/Oslo'). Ignored for all-day events.", required: false },
      { name: "description", type: "string", description: "Event description / notes.", required: false },
      { name: "location", type: "string", description: "Location string.", required: false },
      { name: "attendees", type: "string[]", description: "Attendee email addresses.", required: false },
      { name: "sendUpdates", type: "string", description: "'all' | 'externalOnly' | 'none' — whether to email attendees.", required: false },
    ],
  },
  {
    method: "events_update",
    scope: CALENDAR_SCOPES.events,
    description:
      "Patch an existing event. Pass only the fields you want to change (summary, start, end, description, location, attendees).",
    parameters: [
      { name: "calendarId", type: "string", description: "Calendar id (defaults to 'primary').", required: false },
      { name: "eventId", type: "string", description: "The event id.", required: true },
      { name: "summary", type: "string", description: "New event title.", required: false },
      { name: "start", type: "string", description: "New start (ISO datetime or 'YYYY-MM-DD').", required: false },
      { name: "end", type: "string", description: "New end (ISO datetime or 'YYYY-MM-DD').", required: false },
      { name: "timeZone", type: "string", description: "IANA timezone (applied to start/end if provided).", required: false },
      { name: "description", type: "string", description: "New description.", required: false },
      { name: "location", type: "string", description: "New location.", required: false },
      { name: "attendees", type: "string[]", description: "Replace the attendee list with these emails.", required: false },
      { name: "sendUpdates", type: "string", description: "'all' | 'externalOnly' | 'none'.", required: false },
    ],
  },
  {
    method: "events_delete",
    scope: CALENDAR_SCOPES.events,
    description: "Delete an event from a calendar.",
    parameters: [
      { name: "calendarId", type: "string", description: "Calendar id (defaults to 'primary').", required: false },
      { name: "eventId", type: "string", description: "The event id.", required: true },
      { name: "sendUpdates", type: "string", description: "'all' | 'externalOnly' | 'none'.", required: false },
    ],
  },
  {
    method: "events_respond",
    scope: CALENDAR_SCOPES.events,
    description:
      "RSVP to an event on behalf of the authenticated user by updating their attendee `responseStatus` ('accepted' | 'declined' | 'tentative' | 'needsAction').",
    parameters: [
      { name: "calendarId", type: "string", description: "Calendar id (defaults to 'primary').", required: false },
      { name: "eventId", type: "string", description: "The event id.", required: true },
      { name: "responseStatus", type: "string", description: "'accepted' | 'declined' | 'tentative' | 'needsAction'.", required: true },
      { name: "sendUpdates", type: "string", description: "'all' | 'externalOnly' | 'none'.", required: false },
    ],
  },
  {
    method: "events_move",
    scope: CALENDAR_SCOPES.events,
    description: "Move an event from one calendar to another. Both source and destination must be owned by the user.",
    parameters: [
      { name: "calendarId", type: "string", description: "Source calendar id (defaults to 'primary').", required: false },
      { name: "eventId", type: "string", description: "The event id.", required: true },
      { name: "destination", type: "string", description: "Destination calendar id.", required: true },
      { name: "sendUpdates", type: "string", description: "'all' | 'externalOnly' | 'none'.", required: false },
    ],
  },
  {
    method: "freebusy_query",
    scope: CALENDAR_SCOPES.readonly,
    description:
      "Query free/busy status for one or more calendars over a time window. Returns busy time ranges per calendar — useful for scheduling.",
    parameters: [
      { name: "timeMin", type: "string", description: "Start of the window (RFC3339).", required: true },
      { name: "timeMax", type: "string", description: "End of the window (RFC3339).", required: true },
      { name: "calendarIds", type: "string[]", description: "Calendar ids to query (defaults to ['primary']).", required: false },
      { name: "timeZone", type: "string", description: "IANA timezone for the response.", required: false },
    ],
  },
];
