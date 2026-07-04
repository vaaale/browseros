// Framework-free method metadata for ContactsAdapter. Split out of
// contacts.ts (which is `server-only`) so the CLIENT dispatcher can walk this
// list to register CopilotKit actions without pulling in Node/Google APIs.
//
// The metadata here does NOT include the `invoke` closure — that lives with
// the adapter in contacts.ts and is only used server-side by the invoke route
// (see actions/adapter-registry.ts).
//
// Method ids follow the BOS `<object>_<verb>` snake_case tool-naming standard.

import { CONTACTS_SCOPES } from "../manifest";
import type { AdapterMethodParameter } from "../../../actions/types";

export type ContactsMethodName =
  | "contacts_list"
  | "contacts_get"
  | "contacts_search";

export interface ContactsMethodDescriptor {
  method: ContactsMethodName;
  scope: string;
  description: string;
  parameters: AdapterMethodParameter[];
}

const DEFAULT_PERSON_FIELDS = "names,emailAddresses,phoneNumbers,organizations,photos";

export const CONTACTS_METHOD_DESCRIPTORS: readonly ContactsMethodDescriptor[] = [
  {
    method: "contacts_list",
    scope: CONTACTS_SCOPES.readonly,
    description:
      "List the authenticated user's contacts (People API `people.connections.list`). Returns names, email addresses, phone numbers, organizations, and photos.",
    parameters: [
      { name: "pageSize", type: "number", description: "Max results per page (default 100, cap 1000).", required: false },
      { name: "pageToken", type: "string", description: "Next page token from a previous call.", required: false },
      { name: "personFields", type: "string", description: `Comma-separated fields to return (default '${DEFAULT_PERSON_FIELDS}').`, required: false },
      { name: "sortOrder", type: "string", description: "'LAST_MODIFIED_ASCENDING' | 'LAST_MODIFIED_DESCENDING' | 'FIRST_NAME_ASCENDING' | 'LAST_NAME_ASCENDING'.", required: false },
    ],
  },
  {
    method: "contacts_get",
    scope: CONTACTS_SCOPES.readonly,
    description:
      "Fetch a single contact by resourceName (e.g. 'people/c1234567890'). Returns the same fields as contacts_list.",
    parameters: [
      { name: "resourceName", type: "string", description: "The contact resource name, e.g. 'people/c1234567890'.", required: true },
      { name: "personFields", type: "string", description: `Comma-separated fields to return (default '${DEFAULT_PERSON_FIELDS}').`, required: false },
    ],
  },
  {
    method: "contacts_search",
    scope: CONTACTS_SCOPES.readonly,
    description:
      "Search the authenticated user's contacts by free-text query (matches names, email addresses, phone numbers). Uses the People API's `people:searchContacts` endpoint.",
    parameters: [
      { name: "query", type: "string", description: "Free-text query.", required: true },
      { name: "pageSize", type: "number", description: "Max results (default 25, cap 30 per People API).", required: false },
      { name: "readMask", type: "string", description: `Comma-separated fields to return (default '${DEFAULT_PERSON_FIELDS}').`, required: false },
    ],
  },
];
