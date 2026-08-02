# Headless-Client Auth: Generic Service Secrets & Bastion Credential Routing

**Stability: MODERATE — mechanism is fixed; consumers will grow over time**

Spec: `034-secrets-authentication` (see the external spec store's
`bos-system-specs/034-secrets-authentication/` for the full spec/plan/tasks).

Any BOS server-side feature that needs to authenticate a non-browser client —
one that cannot carry a session cookie at all (a filesystem-mount client, a
CLI, a sync agent) — has one shared mechanism to do it with, and it works
identically whether BOS runs standalone or behind the multi-user Bastion
reverse proxy, including when Bastion is configured with Keycloak.

## The building block: `src/lib/secrets/service-secrets.ts`

```ts
import { createSecret, verifySecret, listSecrets, revokeSecret, hasAnySecret } from "@/lib/secrets/service-secrets";

const { rawSecret, secretId } = await createSecret("my-protocol", "laptop mount");
// show rawSecret to the user ONCE — it is never retrievable again

await verifySecret("my-protocol", candidate); // throws if no match
await listSecrets("my-protocol");             // metadata only, never the raw value or a hash
await revokeSecret("my-protocol", secretId);
await hasAnySecret("my-protocol");
```

**To adopt this for a new service, that's it.** Pick a `service` string that's
yours alone (any BOS feature can call this — the only project convention is
"don't collide with another feature's namespace, and don't use `:`"), mint
secrets under it, and verify a presented candidate the same way BOS verifies
its own login. There is nothing to register, no central list to update, and
**nothing to change in Bastion** — see below for why.

Where your service's secret gets **presented** by the headless client is
entirely up to you: an `Authorization: Bearer <secret>` header your own API
route checks, HTTP Basic auth, a custom header — `verifySecret()` doesn't
care how the candidate string reached your code, only that it matches.

### What actually gets stored

- The authoritative record — a per-secret salted, slow (scrypt-class) hash —
  lives in the existing encrypted per-user store
  (`src/lib/integrations/secrets/store.ts`, AES-256-GCM at rest), under the
  fixed integration id `"service-secrets"`, keyed by `"<service>:<secretId>"`.
  This file lives inside the user's own data dir and is never readable
  without that user's `.integrations-key`.
- A companion record — `sha256(rawSecret)` (fast, unsalted, deliberately
  **not** the same hash as the authoritative one) plus which `service` minted
  it — is written to a small plaintext file,
  `data/system/credentials-index.json`, by
  `src/lib/secrets/credentials-index.ts`. This is a **routing aid only**: it
  cannot authenticate anything on its own (there's no way from a hash back to
  the raw value), it exists purely so a process that does *not* hold the
  encryption key — Bastion — can still figure out which user's container a
  presented secret belongs to.

`createSecret`/`revokeSecret` keep both records in sync automatically — you
never touch `credentials-index.ts` directly.

### Standalone BOS (no Bastion)

`verifySecret()` checks only the encrypted store. The companion index is
never consulted to authenticate a request — that file exists purely for
Bastion's benefit and standalone BOS has no dependency on it at all.

## How Bastion routes a headless request

Bastion normally routes by session cookie. A request with **no session
cookie but a parseable `Authorization: Basic <...>` header** is instead
routed by `bastion/src/credential-routing.ts`'s `resolveCredential()`:

```
for each provisioned username under the users-data root:
  read <username>/data/system/credentials-index.json
  if sha256(presented password) is a key in its entries:
    return { username, service }
```

The Basic-auth *username* the client sends is **never used for anything** —
only the presented password (the raw secret) determines routing. On a match,
`bastion/src/proxy.ts` rewrites the header to `Authorization: Bearer <secret>`
and proxies to that user's container exactly as it would for a session-based
request. On no match, it answers `401` with
`WWW-Authenticate: Basic realm="BrowserOS"` — never a redirect to `/login`
(a headless client can't follow that anyway).

**Bastion never decides whether the secret is valid.** It only decides
*whose* container to send the request to. The target container's own
`verifySecret()` call remains the sole authority — this is why a secret
revoked mid-flight fails safely: Bastion might still have a stale companion
entry for an instant, but the container itself rejects it regardless.

### Why this needs zero Bastion changes per new service

`credential-routing.ts` and `proxy.ts` contain **no protocol-specific
constant or path check anywhere** — the trigger is exclusively "no session,
Basic auth present." They never inspect `req.url`/`req.path`, and they never
ask the configured identity provider (`AUTH_PROVIDER=simple` or
`AUTH_PROVIDER=keycloak`) to resolve a username — which is also what makes
this work behind Keycloak without ever granting Bastion an identity-provider
admin-API credential. Adding your service's secret to the same companion
index is enough; Bastion finds it the same way it finds every other
service's.

This is proven, not just asserted, by `tests/services/second-service-generalization.test.ts`:
it mints a secret under a brand-new, independent `service` namespace via the
real `service-secrets.ts`, and drives it through the real
`resolveCredential()` + `createBosProxy()` middleware to a path Bastion has
never special-cased — with zero Bastion code touched beyond what this
feature introduced. `tests/bastion/proxy-headless-auth.test.ts` separately
proves the routing behaves identically under both `AUTH_PROVIDER=simple` and
`AUTH_PROVIDER=keycloak` (parity, not two code paths — there's only one),
and that revoking a secret's companion index entry makes the very next
request using it fail.

## Checklist for a new headless-client-auth consumer

**This checklist assumes your consuming code can `import` this module directly** —
true for any Next.js API route or browser-side app code, but **not** true for
a marketplace-item's `services/` facet, which runs as an unbundled worker
thread and structurally cannot `import` any `@/`-graph module at all (see
`docs/dev/apps/services.md` §6, `target-marketplace-item.md`). If you're
building a service facet, skip to "Worker-thread services" below instead —
using this checklist as written for a worker thread is exactly the mistake
that shipped once already (a WebDAV service hand-rolled its own token
scheme, entirely bypassing `credentials-index.json`, so Bastion rejected
every request before it ever reached the service's own check).

1. Pick a `service` name (e.g. `"my-mount-protocol"`).
2. Wherever your feature currently lets a user create a credential (a
   settings page, a CLI command, an onboarding step), call
   `createSecret(service, label)` and show `rawSecret` to the user once.
3. In your own API route, extract the client's presented credential
   (`Authorization: Bearer ...`, Basic auth, a custom header — your choice)
   and call `verifySecret(service, candidate)`.
4. Offer `listSecrets(service)` / `revokeSecret(service, secretId)` wherever
   your feature manages issued credentials.
5. Nothing else. If your clients need Basic auth specifically and run behind
   Bastion, they already work — Bastion's generic routing covers you as soon
   as step 2 has run (which is also what writes the companion index entry).

## Worker-thread services (marketplace-item `services/` facets)

A service facet can't call `createSecret`/`verifySecret` directly — same
restriction that already applies to VFS access (`@/os/vfs`), solved the same
way: a loopback HTTP bridge, so the worker thread never touches crypto,
hashing, or storage at all.

- **Mint/list/revoke** — `POST`/`GET`/`DELETE /api/secrets/<service>`
  (`src/app/api/secrets/[service]/route.ts`). Called from the **browser**
  (the service's Settings config page), never from the worker thread — these
  are always user-initiated actions. This route requires an actual verified
  session (`hasSessionScope()`, `src/lib/secrets/auth-scope.ts`) and rejects
  a request routed in via ANY per-service secret, regardless of which service
  minted it — see "Why not under `/api/services/[id]/*`" below for why that
  matters.
- **Verify** — `POST /api/secrets/<service>/verify`
  (`src/app/api/secrets/[service]/verify/route.ts`). Called from the
  **worker thread itself**, over a plain loopback request
  (`fetch('http://127.0.0.1:<port>/api/secrets/<service>/verify', { method: "POST", body: JSON.stringify({ candidate }) })`),
  on every incoming request it needs to authenticate — the same shape as its
  existing `/api/fs` calls. Returns `{ valid: boolean }`; never throws for a
  simple mismatch. Restricted to loopback-only callers (`isLoopbackOnly()`)
  so it can't be used as an external token-guessing oracle.

Net effect: the service's own code never generates a token, never hashes
anything, never reads or writes a `hashedToken` field in its own config — it
just calls `verify` the same way it calls `vfsList`/`vfsRead`. "The consuming
service doesn't have to think about propagating tokens anywhere" (the whole
point of this mechanism) is now literally true for worker threads too, not
just for `@/`-graph code.

### Why not under `/api/services/[id]/*`

Bastion's headless routing resolves WHICH CONTAINER a presented secret
belongs to — it never restricts WHICH PATH within that container the request
is allowed to reach (`bastion/src/proxy.ts` forwards the original request
path unchanged, regardless of which service's secret authenticated it). So a
mint/list/revoke surface nested under the generically-service-scoped
`/api/services/[id]/*` prefix would let a narrow-purpose secret (a WebDAV
file-access token) also mint, list, or revoke secrets for every OTHER
service in the same container — a real privilege-escalation path, not a
naming nitpick. Putting admin operations at a separate `/api/secrets/*`
prefix, gated on `hasSessionScope()`, closes that off structurally: no
per-service secret, however "valid," ever satisfies it.

### The trust-propagation mechanism (`x-bos-auth-scope`)

Bastion (`bastion/src/proxy.ts`) is the only place that ever verifies a raw
credential — a session JWT's signature, or a secret's hash against
`credentials-index.json`. It asserts the verified result downstream as a
sanitized header (client-supplied values are stripped first, so this can
never be forged):

- `x-bos-auth-scope: session` — a verified browser session. Additionally
  `x-bos-auth-role: admin` when `SessionPayload.isAdmin` is set (the same
  claim Bastion's own admin router already checks internally —
  `bastion/src/routers/admin.ts` — propagated one hop further).
- `x-bos-auth-scope: secret:<service>` — a headless request routed by a
  per-service secret, never a session.
- Absent entirely — the request never crossed Bastion at all (a genuine
  same-container loopback call, or this instance isn't running behind a
  Supervisor/Bastion in the first place).

`src/lib/secrets/auth-scope.ts` exposes `hasSessionScope()` (only "session"
passes) and `isLoopbackOnly()` (only "absent" passes) as the two checks any
future admin-vs-loopback surface needs — this generalizes to a future
per-role requirement (e.g. "service X's admin operations require the `admin`
role") without changing shape, since the claim vocabulary is just a header
value Bastion is free to widen.
