import { NextRequest, NextResponse } from "next/server";
import { CAPABILITIES } from "@/lib/agent/capabilities-registry";
import { readOverrides, setOverride } from "@/lib/agent/tool-descriptions";

export const dynamic = "force-dynamic";

// GET  -> { catalog: CAPABILITIES, overrides: Record<toolId, override> }
// PATCH { id, description? } -> ok
//   `description` empty/omitted clears the override (falls back to source).
export async function GET() {
  const overrides = await readOverrides();
  return NextResponse.json({ catalog: CAPABILITIES, overrides });
}

export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json();
    const id = String(body?.id ?? "");
    if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
    if (!CAPABILITIES.some((c) => c.id === id)) {
      return NextResponse.json({ error: `unknown tool: ${id}` }, { status: 400 });
    }
    const description = typeof body.description === "string" ? body.description : undefined;
    await setOverride(id, description);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
