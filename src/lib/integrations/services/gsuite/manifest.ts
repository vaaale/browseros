import type { IntegrationManifest } from "../../types";

// Gmail scopes — full URLs are what Google returns in `granted_scopes`, so we
// use them verbatim as ids. The short aliases we use in adapter code
// (`gmail.readonly`, etc.) are convenience labels — see plan.md §D6 note.
// The UI's `scopeLabel()` maps full URLs → friendly labels.
export const GMAIL_SCOPES = {
  readonly: "https://www.googleapis.com/auth/gmail.readonly",
  modify: "https://www.googleapis.com/auth/gmail.modify",
  send: "https://www.googleapis.com/auth/gmail.send",
} as const;

// Drive scopes — read-only in Phase 3. `drive.readonly` sees every file the
// user has; `drive.file` restricts to files this app has created. The Drive
// service config page shows a `DriveConfigSection` explainer for the
// difference.
export const DRIVE_SCOPES = {
  readonly: "https://www.googleapis.com/auth/drive.readonly",
  file: "https://www.googleapis.com/auth/drive.file",
} as const;

// Calendar scopes — declared for the manifest so the service surfaces in the
// UI. The actual CalendarAdapter is a Phase 4 concern (Phase 3 ships a stub).
export const CALENDAR_SCOPES = {
  readonly: "https://www.googleapis.com/auth/calendar.readonly",
  events: "https://www.googleapis.com/auth/calendar.events",
} as const;

// Contacts scope — the People API's read-only surface. Adapter is a Phase 4
// stub in Phase 3.
export const CONTACTS_SCOPES = {
  readonly: "https://www.googleapis.com/auth/contacts.readonly",
} as const;

// Union of all scopes this integration can request. Duplicates are impossible
// (each URL appears in exactly one group) but we still normalise via a Set to
// document the invariant.
const ALL_SCOPES = Array.from(
  new Set<string>([
    ...Object.values(GMAIL_SCOPES),
    ...Object.values(DRIVE_SCOPES),
    ...Object.values(CALENDAR_SCOPES),
    ...Object.values(CONTACTS_SCOPES),
  ]),
);

export const GSUITE_MANIFEST: IntegrationManifest = {
  id: "gsuite",
  name: "GSuite",
  version: "1.1.0",
  description: "Google Workspace — Gmail, Drive, Calendar, Contacts.",
  icon: "Mail",
  oauthConfig: {
    authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    supportedScopes: ALL_SCOPES,
  },
  services: [
    {
      id: "gmail",
      name: "Gmail",
      description: "Read, send, and manage messages in your Gmail inbox.",
      icon: "Mail",
      scopes: [GMAIL_SCOPES.readonly, GMAIL_SCOPES.modify, GMAIL_SCOPES.send],
      configSchema: {
        type: "object",
        properties: {
          poll: {
            type: "object",
            description: "Polling configuration. See scheduler/types.ts for shape.",
            properties: {
              enabled: { type: "boolean", default: false },
              intervalSec: { type: "number", default: 300 },
            },
          },
          webhook: {
            type: "object",
            description: "Webhook (push) configuration. See webhooks/store.ts for shape.",
            properties: {
              enabled: { type: "boolean", default: false },
              topicName: { type: "string", description: "GCP Pub/Sub topic (projects/<id>/topics/<name>)." },
              subscriptionId: { type: "string", description: "GCP Pub/Sub push subscription id." },
              labelIds: { type: "array", items: { type: "string" }, default: ["INBOX"] },
            },
          },
        },
      },
    },
    {
      id: "drive",
      name: "Drive",
      description: "Browse, search, and download files from Google Drive.",
      icon: "FolderOpen",
      scopes: [DRIVE_SCOPES.readonly, DRIVE_SCOPES.file],
      configSchema: {
        type: "object",
        properties: {
          rootFolderId: {
            type: "string",
            default: "",
            description: "Drive folder id to use as the browsing root (empty = user's Drive root).",
          },
          fileTypes: {
            type: "array",
            items: { type: "string" },
            default: [],
            description: "Filter by MIME types (empty = all types).",
          },
          showInFileApp: {
            type: "boolean",
            default: false,
            description: "Mount Drive as an accessible folder in the Files app (deferred, currently no-op).",
          },
        },
      },
    },
    {
      id: "calendar",
      name: "Calendar",
      description: "Read upcoming events and reminders (write support: coming in Phase 4).",
      icon: "Calendar",
      scopes: [CALENDAR_SCOPES.readonly, CALENDAR_SCOPES.events],
      configSchema: {
        type: "object",
        properties: {
          calendarId: {
            type: "string",
            default: "primary",
            description: "Calendar id to use ('primary' or a specific calendar id).",
          },
          reminderMinutesBefore: {
            type: "number",
            default: 15,
            description: "Notify this many minutes before an event.",
          },
          maxEvents: {
            type: "number",
            default: 20,
            description: "Max upcoming events to track.",
          },
        },
      },
    },
    {
      id: "contacts",
      name: "Contacts",
      description: "Read contact directory (implementation: coming in Phase 4).",
      icon: "Users",
      scopes: [CONTACTS_SCOPES.readonly],
      configSchema: {
        type: "object",
        properties: {
          maxContacts: {
            type: "number",
            default: 500,
            description: "Max contacts to fetch per sync.",
          },
        },
      },
    },
  ],
};
