// Framework-free method metadata for DriveAdapter. Split out of drive.ts
// (which is `server-only`) so the CLIENT dispatcher can walk this list to
// register CopilotKit actions without pulling in Node/Google APIs.
//
// The metadata here does NOT include the `invoke` closure — that lives with
// the adapter in drive.ts and is only used server-side by the invoke route
// (see actions/adapter-registry.ts).
//
// Method ids follow the BOS `<object>_<verb>` snake_case tool-naming standard
// (see capabilities-registry.ts). The DriveAdapter TS class methods stay in
// camelCase (`listFiles`, `getFile`, …) — the invoker map in `drive.ts` bridges
// tool id → adapter method.

import { DRIVE_SCOPES } from "../manifest";
import type { AdapterMethodParameter } from "../../../actions/types";

export type DriveMethodName =
  | "files_list"
  | "files_get"
  | "files_search"
  | "files_download"
  | "files_export"
  | "folders_list"
  | "about_get";

export interface DriveMethodDescriptor {
  method: DriveMethodName;
  scope: string;
  description: string;
  parameters: AdapterMethodParameter[];
}

// One descriptor per adapter method. Keep IN SYNC with DRIVE_METHODS in
// drive.ts — the server-side list adds an `invoke` closure on top of these
// fields.
export const DRIVE_METHOD_DESCRIPTORS: readonly DriveMethodDescriptor[] = [
  {
    method: "files_list",
    scope: DRIVE_SCOPES.readonly,
    description:
      "List files in the user's Google Drive. Optional `q` (Drive query language), `pageSize`, `pageToken`, `orderBy`, `fields`. Prefer this over files_search for pagination.",
    parameters: [
      { name: "q", type: "string", description: "Drive query, e.g. \"'root' in parents and trashed=false\".", required: false },
      { name: "pageSize", type: "number", description: "Max results per page (default 100, cap 1000).", required: false },
      { name: "pageToken", type: "string", description: "Next page token from a previous call.", required: false },
      { name: "orderBy", type: "string", description: "Comma-separated sort keys (e.g. 'modifiedTime desc,name').", required: false },
      { name: "fields", type: "string", description: "Partial-response fields (e.g. 'files(id,name,mimeType)').", required: false },
    ],
  },
  {
    method: "files_get",
    scope: DRIVE_SCOPES.readonly,
    description: "Fetch a Drive file's metadata by id. Returns id, name, mimeType, size, modifiedTime, parents, webViewLink.",
    parameters: [
      { name: "id", type: "string", description: "The Drive file id.", required: true },
      { name: "fields", type: "string", description: "Partial-response fields (default 'id,name,mimeType,size,modifiedTime,parents,webViewLink').", required: false },
    ],
  },
  {
    method: "files_search",
    scope: DRIVE_SCOPES.readonly,
    description:
      "Search Drive using the Drive query syntax. Examples: \"name contains 'invoice'\", \"mimeType='application/pdf'\", \"modifiedTime > '2024-01-01T00:00:00'\".",
    parameters: [
      { name: "q", type: "string", description: "Drive query string.", required: true },
      { name: "pageSize", type: "number", description: "Max results per page.", required: false },
      { name: "pageToken", type: "string", description: "Next page token.", required: false },
    ],
  },
  {
    method: "files_download",
    scope: DRIVE_SCOPES.readonly,
    description:
      "Download a Drive file's binary content. Returns { contentType, base64 } for files under maxBytes (default 256 KB) or { error: 'too_large', size } for larger files. For Google-native docs (Docs/Sheets/Slides) use files_export instead.",
    parameters: [
      { name: "id", type: "string", description: "The Drive file id.", required: true },
      { name: "maxBytes", type: "number", description: "Cap on response size (default 262144).", required: false },
    ],
  },
  {
    method: "files_export",
    scope: DRIVE_SCOPES.readonly,
    description:
      "Export a Google-native document (Docs, Sheets, Slides) as another MIME type — e.g. mimeType='application/pdf' for Docs → PDF, 'text/csv' for Sheets, 'text/plain' for plain-text extraction.",
    parameters: [
      { name: "id", type: "string", description: "The Google-native file id.", required: true },
      { name: "mimeType", type: "string", description: "Target export MIME type (application/pdf, text/csv, text/plain, text/html, ...).", required: true },
      { name: "maxBytes", type: "number", description: "Cap on response size (default 262144).", required: false },
    ],
  },
  {
    method: "folders_list",
    scope: DRIVE_SCOPES.readonly,
    description:
      "List folders in Drive (mimeType='application/vnd.google-apps.folder'). Optional `parentId` restricts to a folder's children.",
    parameters: [
      { name: "parentId", type: "string", description: "Parent folder id (defaults to the whole Drive).", required: false },
      { name: "pageSize", type: "number", description: "Max results per page.", required: false },
      { name: "pageToken", type: "string", description: "Next page token.", required: false },
    ],
  },
  {
    method: "about_get",
    scope: DRIVE_SCOPES.readonly,
    description:
      "Fetch the authenticated user's Drive profile — { user: {emailAddress, displayName}, storageQuota: {limit, usage, usageInDrive} }. Used by the Drive settings card to show 'Connected as ...'.",
    parameters: [],
  },
];
