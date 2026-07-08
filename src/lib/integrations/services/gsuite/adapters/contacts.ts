import "server-only";
import { ServiceAdapter } from "../../../adapters/base";
import { getService } from "../../../registry";
import { IntegrationConfigError } from "../../../errors";
import type { ServiceDefinition } from "../../../types";
import type { AdapterMethodMeta } from "../../../actions/types";
import { gsuiteFetch, buildUrl } from "../client";
import { CONTACTS_SCOPES } from "../manifest";
import { CONTACTS_METHOD_DESCRIPTORS, type ContactsMethodName } from "./contacts-methods";
import { registerAdapter, getAdapterEntry } from "../../../actions/adapter-registry";

// ContactsAdapter — read-only surface over Google People API. Mirrors the
// GmailAdapter / DriveAdapter shape: every public method is scope-gated via
// `withScope`, all HTTP goes through `gsuiteFetch`, and return values are
// plain JSON that the CopilotKit dispatcher can pass through verbatim.

const BASE = "https://people.googleapis.com/v1";
const DEFAULT_PERSON_FIELDS = "names,emailAddresses,phoneNumbers,organizations,photos";

// --- Types ---------------------------------------------------------------

export interface PersonName {
  displayName?: string;
  givenName?: string;
  familyName?: string;
}
export interface PersonEmail {
  value?: string;
  type?: string;
  primary?: boolean;
}
export interface PersonPhone {
  value?: string;
  type?: string;
  primary?: boolean;
}
export interface PersonOrg {
  name?: string;
  title?: string;
  department?: string;
}
export interface PersonPhoto {
  url?: string;
  default?: boolean;
}
export interface Contact {
  resourceName: string;
  etag?: string;
  names?: PersonName[];
  emailAddresses?: PersonEmail[];
  phoneNumbers?: PersonPhone[];
  organizations?: PersonOrg[];
  photos?: PersonPhoto[];
}

export interface ListContactsParams {
  pageSize?: number;
  pageToken?: string;
  personFields?: string;
  sortOrder?:
    | "LAST_MODIFIED_ASCENDING"
    | "LAST_MODIFIED_DESCENDING"
    | "FIRST_NAME_ASCENDING"
    | "LAST_NAME_ASCENDING";
}
export interface ListContactsResult {
  connections: Contact[];
  nextPageToken?: string;
  totalPeople?: number;
}

export interface GetContactParams {
  resourceName: string;
  personFields?: string;
}

export interface SearchContactsParams {
  query: string;
  pageSize?: number;
  readMask?: string;
}
export interface SearchContactsResult {
  results: Contact[];
}

// --- Helpers -------------------------------------------------------------

function serviceDef(): ServiceDefinition {
  const svc = getService("gsuite", "contacts");
  if (!svc) {
    throw new IntegrationConfigError("Contacts service is not registered on the gsuite integration.", {
      integrationId: "gsuite",
    });
  }
  return svc;
}

// --- Adapter -------------------------------------------------------------

export class ContactsAdapter extends ServiceAdapter {
  constructor() {
    super("gsuite", serviceDef());
  }

  async listContacts(params: ListContactsParams = {}): Promise<ListContactsResult> {
    return this.withScope(CONTACTS_SCOPES.readonly, async () => {
      const url = buildUrl(BASE, "/people/me/connections", {
        pageSize: params.pageSize,
        pageToken: params.pageToken,
        personFields: params.personFields ?? DEFAULT_PERSON_FIELDS,
        sortOrder: params.sortOrder,
      });
      const res = await gsuiteFetch<{
        connections?: Contact[];
        nextPageToken?: string;
        totalPeople?: number;
      }>(this, url);
      return {
        connections: res.connections ?? [],
        nextPageToken: res.nextPageToken,
        totalPeople: res.totalPeople,
      };
    });
  }

  async getContact(params: GetContactParams): Promise<Contact> {
    return this.withScope(CONTACTS_SCOPES.readonly, async () => {
      // People API resource names include a slash (e.g. `people/c123`). We keep
      // that segment verbatim in the path — encoding would turn it into an
      // opaque id the API rejects.
      const url = buildUrl(BASE, `/${params.resourceName}`, {
        personFields: params.personFields ?? DEFAULT_PERSON_FIELDS,
      });
      return gsuiteFetch<Contact>(this, url);
    });
  }

  async searchContacts(params: SearchContactsParams): Promise<SearchContactsResult> {
    return this.withScope(CONTACTS_SCOPES.readonly, async () => {
      const url = buildUrl(BASE, "/people:searchContacts", {
        query: params.query,
        pageSize: params.pageSize,
        readMask: params.readMask ?? DEFAULT_PERSON_FIELDS,
      });
      const res = await gsuiteFetch<{ results?: Array<{ person?: Contact }> }>(this, url);
      // People API's searchContacts wraps each hit in `{ person: {...} }`.
      // Flatten so the tool shape matches contacts_list.
      return {
        results: (res.results ?? [])
          .map((r) => r.person)
          .filter((p): p is Contact => Boolean(p)),
      };
    });
  }
}

// --- Method metadata -----------------------------------------------------

const CONTACTS_INVOKERS: Record<
  ContactsMethodName,
  (adapter: ContactsAdapter, args: Record<string, unknown>) => Promise<unknown>
> = {
  contacts_list: (adapter, args) =>
    adapter.listContacts({
      pageSize: args.pageSize as number | undefined,
      pageToken: args.pageToken as string | undefined,
      personFields: args.personFields as string | undefined,
      sortOrder: args.sortOrder as ListContactsParams["sortOrder"],
    }),
  contacts_get: (adapter, args) =>
    adapter.getContact({
      resourceName: String(args.resourceName),
      personFields: args.personFields as string | undefined,
    }),
  contacts_search: (adapter, args) =>
    adapter.searchContacts({
      query: String(args.query),
      pageSize: args.pageSize as number | undefined,
      readMask: args.readMask as string | undefined,
    }),
};

export const CONTACTS_METHODS: readonly AdapterMethodMeta<ContactsAdapter>[] =
  CONTACTS_METHOD_DESCRIPTORS.map((d) => ({
    method: d.method,
    scope: d.scope,
    description: d.description,
    parameters: d.parameters,
    invoke: CONTACTS_INVOKERS[d.method],
  }));

export type { ContactsMethodName } from "./contacts-methods";

// --- Registration --------------------------------------------------------
if (!getAdapterEntry("gsuite", "contacts")) {
  registerAdapter("gsuite", "contacts", {
    createAdapter: () => new ContactsAdapter(),
    methods: CONTACTS_METHODS,
  });
}
