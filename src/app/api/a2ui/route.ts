import { NextRequest, NextResponse } from "next/server";
import { generateA2UI, patchA2UI, type A2UIComponentSnapshot } from "@/lib/a2ui/service";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// A2UI generation endpoint (025-ui-preview-a2ui-tools). Called by the UI
// Preview app's `ui_preview_generate`/`ui_preview_patch` frontend tools (which
// run in the browser and therefore can't reach the LLM provider secrets
// directly). The tool handler posts here, gets back a validated operations
// envelope, and renders it into the live surface itself.
//   POST { mode:"generate", description, surfaceId? }
//   POST { mode:"patch", description, surfaceId?, currentComponents }
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    mode?: string;
    description?: string;
    surfaceId?: string;
    currentComponents?: A2UIComponentSnapshot[];
  };
  const description = typeof body.description === "string" ? body.description.trim() : "";
  if (!description) {
    return NextResponse.json({ ok: false, error: "A description is required." }, { status: 400 });
  }
  const surfaceId = typeof body.surfaceId === "string" ? body.surfaceId : undefined;

  const result =
    body.mode === "patch"
      ? await patchA2UI({
          description,
          surfaceId,
          currentComponents: Array.isArray(body.currentComponents) ? body.currentComponents : [],
          signal: req.signal,
        })
      : await generateA2UI({ description, surfaceId, signal: req.signal });

  return NextResponse.json(result);
}
