# External Integrations (GSuite / Gmail — Phase 1)

BrowserOS integrations are a pluggable framework for connecting third-party
services (Gmail, Drive, Calendar, Telegram, …) to the OS and its assistant.
Every integration exposes:

- **Manifest** — id, name, OAuth config, one or more services (each with its own
  scope set and per-service config schema).
- **Adapter(s)** — server-only classes that implement the service's methods
  (Gmail `listMessages`, `sendMessage`, …). Each method is scope-gated via the
  base adapter's `withScope`.
- **Assistant actions** — one CopilotKit action per adapter method, auto-
  registered by `IntegrationActions.tsx` and gated by the user's effective
  scope set.
- **Settings UI** — the Integrations tab in Settings (list → detail → per-
  service config) drives connect / disconnect / scope overrides.
- **Notifications** — adapters can emit `IntegrationEvent`s (e.g. Gmail's
  `pollOnce` → `new_email`), which the notifications store persists and the
  Topbar badge counts.

Phase 1 ships one integration (GSuite) with one service (Gmail) and 11 adapter
methods. This document is the smoke-test walkthrough and the recipe for adding
a new adapter method or service.

## Directory layout

```
src/lib/integrations/
├── types.ts                       # framework-free public shapes
├── errors.ts                      # IntegrationError hierarchy
├── registry.ts                    # register/lookup manifests
├── paths.ts                       # data/integrations/... locations
├── index.ts                       # public entry, side-effect registers services
├── secrets/                       # AES-256 SecretsStore (server-only)
├── oauth/                         # PKCE OAuth manager (server-only)
├── state/                         # per-integration state.json store (server-only)
├── adapters/base.ts               # ServiceAdapter (withScope, authedFetch)
├── actions/
│   ├── types.ts                   # AdapterMethodMeta (framework-free)
│   ├── dispatcher.ts              # actionNameFor + invokeAdapterMethod (client)
│   └── adapter-registry.ts        # server-side (integrationId, serviceId) → adapter
├── notifications/store.ts         # append-only inbox + badge counter
└── services/gsuite/
    ├── manifest.ts                # GSUITE_MANIFEST + GMAIL_SCOPES
    ├── client.ts                  # gsuiteFetch (retry + 401 refresh)
    ├── client-secrets.ts          # client_secrets.json normaliser
    └── adapters/
        ├── gmail-methods.ts       # framework-free method descriptors
        └── gmail.ts               # GmailAdapter + GMAIL_METHODS (server-only)

src/app/api/integrations/
├── route.ts                              # GET list
├── [id]/
│   ├── route.ts                          # GET/PATCH one integration
│   ├── client-secret/route.ts            # upload client_secrets.json
│   ├── disconnect/route.ts               # POST clear tokens
│   └── services/[serviceId]/
│       ├── invoke/route.ts               # POST call adapter method
│       └── poll/route.ts                 # POST trigger pollOnce
├── oauth/{start,callback}/route.ts
├── notifications/route.ts                # GET items / POST mark-all-read
└── gsuite/whoami/route.ts

src/components/apps/settings/integrations/   # UI (list, detail, config views)
src/components/agent/IntegrationActions.tsx  # CopilotKit action registration
src/components/desktop/IntegrationsBadge.tsx # Topbar unread badge
```

## End-to-end walkthrough (smoke test)

Prereqs: a Google Cloud OAuth 2.0 Web application client with
`http://localhost:3000/api/integrations/oauth/callback` in Authorised redirect
URIs, and its `client_secrets.json` downloaded.

1. `npm run dev`, open BrowserOS.
2. Settings → **Integrations** → **GSuite** → **Upload client_secrets.json**.
3. Click **Connect** → Google consent screen → grant Gmail scopes (readonly,
   modify, send). You should return to BrowserOS with the integration marked
   *Connected* and the granted scopes listed.
4. Optionally disable one scope (e.g. `gmail.send`) with the per-scope toggle.
   The corresponding assistant action (`gsuite_gmail_sendMessage`) becomes
   unavailable — the LLM will not see it.
5. Ask the assistant "list my unread emails from this week". It should call
   `gsuite_gmail_listMessages` (or `_searchMessages`) with an appropriate
   query and summarise the results.
6. Trigger a manual poll: `POST /api/integrations/gsuite/services/gmail/poll`
   (or the assistant will do this once the scheduler ships). New messages are
   emitted as `new_email` events into the notification inbox.
7. Verify the Topbar bell shows a badge with the unread count. Click it →
   badge clears.
8. Disconnect from Settings → Integrations → GSuite → **Disconnect**. State
   flips to *Not connected*, tokens are wiped from the SecretsStore, per-
   service config is preserved.

## Error contract

Every adapter call returns `{ result }` on 200 and `{ error: { code, message,
scope?, integrationId? } }` on error. `code` is one of:

| code            | HTTP | Meaning                                                               |
| ---             | ---  | ---                                                                    |
| `scope_disabled`| 403  | Scope not granted or user-disabled. Ask user to re-enable in Settings. |
| `auth_failed`   | 401  | Integration not connected / token refresh failed. Ask user to reconnect.|
| `config_invalid`| 400  | `client_secrets.json` missing/malformed. Ask user to re-upload.        |
| `unknown_method`| 404  | Bug — method name doesn't exist on the adapter.                        |
| `no_adapter`    | 404  | Bug — no adapter registered for (integration, service).                |
| `internal`      | 500  | Unclassified adapter error. `message` has the provider's response.     |

The assistant's CORE_POLICY tells it to *stop retrying* on the first three and
explain to the user what needs to happen.

## Naming conventions

- Integration ids and service ids are lowercase, stable identifiers
  (`gsuite`, `gmail`, `drive`).
- Full OAuth scope URLs are the CANONICAL scope id (what the server receives).
  Shortnames (`gmail.readonly`) are for logs and UI only.
- Assistant action names follow `<integrationId>_<serviceId>_<method>` and
  keep the adapter method's own camelCase — the ONLY exception to the
  codebase's snake_case action naming. Grep for `NAMING EXCEPTION` in
  `capabilities-registry.ts` before adding new ids.

## Adding a new adapter method

1. Add the method to the service's adapter (`services/<id>/adapters/<svc>.ts`).
   Wrap every provider call in `this.withScope(FULL_SCOPE_URL, async () => ...)`.
2. Add a descriptor to the framework-free descriptor list (e.g.
   `gmail-methods.ts`) so the CLIENT dispatcher can see it.
3. Add an invoker to the server-side `GMAIL_INVOKERS` map in `gmail.ts`.
4. Add a capability id (`<integrationId>_<serviceId>_<method>`) to the
   Integrations group in `capabilities-registry.ts`.
5. `npx tsc --noEmit`. The client dispatcher and server invoke route will
   pick the method up automatically.

## Adding a new service (same integration)

1. Add a `ServiceDefinition` to the integration's manifest (`manifest.ts`).
2. Create a new adapter under `services/<id>/adapters/<svc>.ts` — extend
   `ServiceAdapter` and declare its own `<SVC>_METHODS`.
3. Register it in `actions/adapter-registry.ts` under the same
   `integrationId` key.
4. Add per-method capability ids to the Integrations group.
5. Add matching per-method wiring to `IntegrationActions.tsx` (a new
   descriptor list + a new `<Service>MethodAction` component analogous to
   `GmailMethodAction`).

## Acceptance criteria (Phase 1 Definition of Done)

- ✅ Every secret and every Google API call happens on the server.
- ✅ Tokens live only in the SecretsStore (AES-256, key file chmod 600).
- ✅ Per-integration state.json is atomically written with a per-integration
  mutex.
- ✅ Every Gmail adapter method is exposed as a CopilotKit action, gated by
  the effective-scope set on BOTH client (`available`) and server
  (`withScope` in the invoke route).
- ✅ Scope overrides in Settings live-update the assistant's available
  actions (via `useIntegrationsEffectiveScopes`).
- ✅ Disconnect wipes tokens and preserves per-service config.
- ✅ Manual poll trigger writes to the notification inbox and bumps the
  Topbar badge.
- ✅ Zero edits to `package.json` / lockfiles / build config.
- ✅ `npx tsc --noEmit` passes.
