import { NextRequest, NextResponse } from "next/server";
import { baseMime } from "@/os/file-handlers";
import { handlersFor, effectiveSelected } from "@/lib/file-handlers/registry";
import { writeSelection } from "@/lib/file-handlers/selection";

// 036-file-type-handlers: the client's window onto the handler registry. The
// Files app asks "who can open text/html, and who is selected?" (GET) and
// records the user's "always open with" choice (POST). The registry is derived
// per request from the live installed-app set, so this route is never stale.
export const dynamic = "force-dynamic";

async function viewFor(mime: string) {
  const [handlers, selected] = await Promise.all([handlersFor(mime), effectiveSelected(mime)]);
  return { mime, handlers, selected: selected?.appId ?? null };
}

/** GET ?mime=<type> → every installed handler for the type + the selected one. */
export async function GET(req: NextRequest) {
  const mime = baseMime(new URL(req.url).searchParams.get("mime") ?? "");
  if (!mime) return NextResponse.json({ error: "mime is required" }, { status: 400 });
  return NextResponse.json(await viewFor(mime));
}

/** POST { mime, appId? } → set the selected handler, or clear it (no appId) to
 *  revert to whichever installed app declares `default: true`. Responds with
 *  the refreshed view so the caller sees the selection the registry actually
 *  honoured, not the one it asked for. */
export async function POST(req: NextRequest) {
  let body: { mime?: unknown; appId?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const mime = typeof body.mime === "string" ? baseMime(body.mime) : "";
  if (!mime) return NextResponse.json({ error: "mime is required" }, { status: 400 });
  const appId = typeof body.appId === "string" && body.appId ? body.appId : null;

  await writeSelection(mime, appId);
  return NextResponse.json(await viewFor(mime));
}
