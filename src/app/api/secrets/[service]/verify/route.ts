import { NextRequest, NextResponse } from "next/server";
import { verifySecret } from "@/lib/secrets/service-secrets";
import { isLoopbackOnly } from "@/lib/secrets/auth-scope";

export const dynamic = "force-dynamic";

// Loopback-only verify — the bridge a worker-thread SERVICE (which cannot
// `import` service-secrets.ts directly, see
// seed/skills/bos-domain/references/target-marketplace-item.md) calls over
// a plain loopback HTTP request on every incoming request it needs to
// authenticate, the same pattern already used for VFS access (/api/fs). This
// is what makes "the consuming service never has to think about propagating
// tokens anywhere" literally true: no hashing, no storage, no config file —
// just a POST per request.
//
// Restricted to callers that never crossed Bastion at all (isLoopbackOnly):
// a request that DID cross Bastion always carries an x-bos-auth-scope header
// (either "session" or "secret:<service>" — see auth-scope.ts), so this
// rejects any externally-reachable attempt to use this route as a
// token-guessing oracle, regardless of which service's secret (if any) was
// presented to get there.
export async function POST(req: NextRequest, ctx: { params: Promise<{ service: string }> }) {
  const { service } = await ctx.params;
  if (!isLoopbackOnly(req)) {
    return NextResponse.json({ error: "This endpoint is for internal use only." }, { status: 403 });
  }
  try {
    const body = await req.json().catch(() => ({}));
    const candidate = typeof (body as { candidate?: unknown }).candidate === "string" ? (body as { candidate: string }).candidate : "";
    if (!candidate) return NextResponse.json({ valid: false });
    await verifySecret(service, candidate);
    return NextResponse.json({ valid: true });
  } catch {
    // No matching secret (verifySecret throws) — a mismatch is not a server
    // error, just "not valid."
    return NextResponse.json({ valid: false });
  }
}
