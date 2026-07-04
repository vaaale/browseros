// Side-effect module: registers the GSuite manifest with the integrations
// registry at import time. The parent barrel `src/lib/integrations/index.ts`
// imports this file so any consumer of the barrel triggers registration.
//
// Adapter self-registration: each adapter file calls `registerAdapter(...)`
// at module load. Importing them here (rather than from
// `actions/adapter-registry.ts`) breaks a circular dependency: the adapters
// import `registerAdapter` from the registry, so having the registry import
// the adapters back would create a TDZ cycle Turbopack can't resolve.

import { registerIntegration } from "../../registry";
import { GSUITE_MANIFEST } from "./manifest";

registerIntegration(GSUITE_MANIFEST);

import "./adapters/gmail";
import "./adapters/drive";
import "./adapters/calendar";
import "./adapters/contacts";

export { GSUITE_MANIFEST, GMAIL_SCOPES, DRIVE_SCOPES, CALENDAR_SCOPES, CONTACTS_SCOPES } from "./manifest";
