import type { IntegrationManifest } from "../../types";

// Gmail scopes — full URLs are what Google returns in `granted_scopes`, so we
// use them verbatim as ids. The short aliases we use in adapter code
// (`gmail.readonly`, etc.) are convenience labels — see plan.md §D6 note.
// In Phase 1 we standardise on the FULL URL as the scope id (what the server
// receives) and the UI shows a friendlier label.
export const GMAIL_SCOPES = {
  readonly: "https://www.googleapis.com/auth/gmail.readonly",
  modify: "https://www.googleapis.com/auth/gmail.modify",
  send: "https://www.googleapis.com/auth/gmail.send",
} as const;

export const GSUITE_MANIFEST: IntegrationManifest = {
  id: "gsuite",
  name: "GSuite",
  version: "1.0.0",
  description: "Google Workspace — Gmail, Drive, Calendar. Phase 1: Gmail only.",
  icon: "Mail",
  oauthConfig: {
    authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    supportedScopes: [GMAIL_SCOPES.readonly, GMAIL_SCOPES.modify, GMAIL_SCOPES.send],
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
          pollIntervalSec: { type: "number", default: 300, description: "Phase 2 — reserved." },
          pollQuery: { type: "string", default: "in:inbox is:unread", description: "Phase 2 — reserved." },
        },
      },
    },
  ],
};
