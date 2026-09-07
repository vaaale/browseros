import { NextRequest, NextResponse } from "next/server";
import { listToolGroups } from "@/lib/agent/tool-groups";
import { getEffectiveGroups, setGroupOverride } from "@/lib/agent/tool-group-overrides";

export const dynamic = "force-dynamic";

// Tool GROUP metadata (041-tool-groups). Kept separate from
// /api/tool-descriptions, which owns per-TOOL descriptions and whose
// { id, description } PATCH contract is unchanged — two entities, two routes.
//
// GET   -> { groups: EffectiveToolGroup[] }   (registry/manifest + user overrides)
// PATCH { groupId, description?, aliases? } -> ok
//   - description: string sets/overwrites; "" or null clears.
//   - aliases: string[] sets; [] or null clears.
//   - Omitted fields preserve the existing stored value.

export async function GET() {
  return NextResponse.json({ groups: await getEffectiveGroups() });
}

export async function PATCH(req: NextRequest) {
  try {
    const body = (await req.json()) as { groupId?: unknown; description?: unknown; aliases?: unknown };
    const groupId = String(body?.groupId ?? "");
    if (!groupId) return NextResponse.json({ error: "groupId is required" }, { status: 400 });

    // An unknown group id is reported with the valid ids rather than silently
    // accepted — there is no fallback group (FR-041). Note this checks the LIVE
    // catalog only for the error message; setGroupOverride itself deliberately
    // still accepts a group whose service is currently stopped (FR-049).
    const live = listToolGroups();
    if (!live.some((g) => g.id === groupId)) {
      return NextResponse.json(
        { error: `unknown tool group: ${groupId}`, availableGroups: live.map((g) => g.id) },
        { status: 400 },
      );
    }

    const patch: { description?: string | null; aliases?: string[] | null } = {};
    if (Object.prototype.hasOwnProperty.call(body, "description")) {
      const d = body.description;
      if (typeof d === "string") patch.description = d;
      else if (d === null) patch.description = null;
      else return NextResponse.json({ error: "description must be string or null" }, { status: 400 });
    }
    if (Object.prototype.hasOwnProperty.call(body, "aliases")) {
      const a = body.aliases;
      if (Array.isArray(a) && a.every((x) => typeof x === "string")) patch.aliases = a as string[];
      else if (a === null) patch.aliases = null;
      else return NextResponse.json({ error: "aliases must be string[] or null" }, { status: 400 });
    }

    await setGroupOverride(groupId, patch);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
