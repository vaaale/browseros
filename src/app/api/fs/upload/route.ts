import { NextRequest, NextResponse } from "next/server";
import path from "path";
import * as vfs from "@/os/vfs";
import { withFeatureScope, scopeFromHeaders } from "@/lib/specs/feature-context";

export const dynamic = "force-dynamic";

// Drag-and-drop upload target (037-files-upload-download). Multipart body:
// `path` (destination VFS directory) + one or more `files` blobs.
export async function POST(req: NextRequest) {
  return withFeatureScope(scopeFromHeaders(req.headers), async () => {
    try {
      const form = await req.formData();
      const dir = String(form.get("path") ?? "/");
      const base = dir === "/" ? "" : dir;
      const files = form.getAll("files").filter((f): f is File => f instanceof File);
      if (files.length === 0) {
        return NextResponse.json({ error: "No files provided" }, { status: 400 });
      }
      const uploaded: string[] = [];
      for (const file of files) {
        const name = path.posix.basename(file.name);
        if (!name || name === "." || name === "..") continue;
        const target = `${base}/${name}`;
        await vfs.writeBuffer(target, Buffer.from(await file.arrayBuffer()));
        uploaded.push(target);
      }
      return NextResponse.json({ ok: true, uploaded });
    } catch (err) {
      return NextResponse.json({ error: (err as Error).message }, { status: 400 });
    }
  });
}
