import { NextRequest, NextResponse } from "next/server";
import { CAPABILITIES } from "@/lib/agent/capabilities-registry";
import {
  getEffectiveCatalog,
  readMetadataOverrides,
  setMetadataOverride,
} from "@/lib/agent/tool-metadata-overrides";

export const dynamic = "force-dynamic";

// GET  -> { catalog: (Capability with EFFECTIVE description + registry-default deferred)[], overrides: metadata-override map }
// PATCH { id, description?: string } -> ok
//   - description: string sets/overwrites; empty string clears.
//   - Omitted fields preserve the existing stored value.
//   - `deferred` is intentionally NOT accepted here — per-agent deferred lists
//     are edited via /api/assistant/agent (Settings → Agents → Tools).
export async function GET() {
  const [catalog, overrides] = await Promise.all([getEffectiveCatalog(), readMetadataOverrides()]);
  return NextResponse.json({ catalog, overrides });
}

export async function PATCH(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      id?: unknown;
      description?: unknown;
    };
    const id = String(body?.id ?? "");
    if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
    if (!CAPABILITIES.some((c) => c.id === id)) {
      return NextResponse.json({ error: `unknown tool: ${id}` }, { status: 400 });
    }

    const patch: { description?: string | null } = {};
    if (Object.prototype.hasOwnProperty.call(body, "description")) {
      const d = body.description;
      if (typeof d === "string") patch.description = d;
      else if (d === null) patch.description = null;
      else return NextResponse.json({ error: "description must be string or null" }, { status: 400 });
    }

    await setMetadataOverride(id, patch);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
