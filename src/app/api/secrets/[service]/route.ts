import { NextRequest, NextResponse } from "next/server";
import { createSecret, listSecrets, revokeSecret } from "@/lib/secrets/service-secrets";
import { hasSessionScope } from "@/lib/secrets/auth-scope";
import { logger } from "@/lib/logging";

export const dynamic = "force-dynamic";

// Generic Secrets admin surface (034-secrets-authentication) — mint/list/
// revoke a scoped, revocable credential under an arbitrary `service`
// namespace. Any BOS feature can call this, not just marketplace-item
// services (see docs/dev/features/headless-client-auth.md).
//
// Deliberately NOT nested under /api/services/[id]/* — that prefix is
// reachable by ANY valid per-service secret once Bastion has routed it into
// this container, because Bastion resolves WHICH container a secret belongs
// to, never WHICH path it's allowed to reach (bastion/src/proxy.ts forwards
// the original request path unchanged). Nesting admin operations there would
// let a narrow-purpose secret (e.g. a WebDAV file-access token) mint, list,
// or revoke secrets for every OTHER service in the same container.
//
// This route instead requires `hasSessionScope()` — Bastion's own asserted
// "session" claim (src/lib/secrets/auth-scope.ts) — and rejects a
// secret-scoped request outright, regardless of which service minted the
// secret it presented. Mint/list/revoke are always browser-initiated (a
// Settings-page action), never something a headless client or a worker
// thread does on its own.

export async function POST(req: NextRequest, ctx: { params: Promise<{ service: string }> }) {
  const { service } = await ctx.params;
  if (!hasSessionScope(req)) {
    return NextResponse.json(
      { error: "This operation requires an authenticated session, not a service credential." },
      { status: 403 },
    );
  }
  try {
    const body = await req.json().catch(() => ({}));
    const label = typeof (body as { label?: unknown }).label === "string" ? (body as { label: string }).label : undefined;
    const created = await createSecret(service, label);
    return NextResponse.json(created);
  } catch (err) {
    logger().error("secrets.api", `POST /api/secrets/${service} failed`, err);
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ service: string }> }) {
  const { service } = await ctx.params;
  if (!hasSessionScope(req)) {
    return NextResponse.json(
      { error: "This operation requires an authenticated session, not a service credential." },
      { status: 403 },
    );
  }
  try {
    const secrets = await listSecrets(service);
    return NextResponse.json({ secrets });
  } catch (err) {
    logger().error("secrets.api", `GET /api/secrets/${service} failed`, err);
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ service: string }> }) {
  const { service } = await ctx.params;
  if (!hasSessionScope(req)) {
    return NextResponse.json(
      { error: "This operation requires an authenticated session, not a service credential." },
      { status: 403 },
    );
  }
  try {
    const body = await req.json().catch(() => ({}));
    const secretId = typeof (body as { secretId?: unknown }).secretId === "string" ? (body as { secretId: string }).secretId : "";
    if (!secretId) return NextResponse.json({ error: "secretId is required" }, { status: 400 });
    await revokeSecret(service, secretId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    logger().error("secrets.api", `DELETE /api/secrets/${service} failed`, err);
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
