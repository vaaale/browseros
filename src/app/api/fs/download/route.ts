import { NextRequest, NextResponse } from "next/server";
import * as vfs from "@/os/vfs";
import { createZip, type ZipEntryInput } from "@/lib/files/zip";
import { withFeatureScope, scopeFromHeaders } from "@/lib/specs/feature-context";

export const dynamic = "force-dynamic";

// Right-click "Download" (037-files-upload-download). A file streams its raw
// bytes as an attachment; a folder is zipped (recursively, including empty
// subfolders) in memory and the zip streams as the attachment instead.
function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "'");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

async function collectRecursive(vfsPath: string, relBase: string, out: ZipEntryInput[]): Promise<void> {
  const entries = await vfs.list(vfsPath);
  if (entries.length === 0) {
    if (relBase) out.push({ name: `${relBase}/` });
    return;
  }
  for (const entry of entries) {
    const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
    if (entry.type === "dir") {
      await collectRecursive(entry.path, rel, out);
    } else {
      out.push({ name: rel, data: await vfs.readBuffer(entry.path), modified: entry.modified });
    }
  }
}

export async function GET(req: NextRequest) {
  const p = new URL(req.url).searchParams.get("path");
  if (!p) return NextResponse.json({ error: "Missing path" }, { status: 400 });
  return withFeatureScope(scopeFromHeaders(req.headers), async () => {
    try {
      const info = await vfs.stat(p);
      if (info.type === "file") {
        const data = await vfs.readBuffer(p);
        return new NextResponse(new Uint8Array(data), {
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Disposition": contentDisposition(info.name),
            "Cache-Control": "no-store",
          },
        });
      }
      const zipEntries: ZipEntryInput[] = [];
      await collectRecursive(p, "", zipEntries);
      const zipBuf = createZip(zipEntries);
      const zipName = `${info.name === "/" ? "root" : info.name}.zip`;
      return new NextResponse(new Uint8Array(zipBuf), {
        headers: {
          "Content-Type": "application/zip",
          "Content-Disposition": contentDisposition(zipName),
          "Cache-Control": "no-store",
        },
      });
    } catch (err) {
      return NextResponse.json({ error: (err as Error).message }, { status: 404 });
    }
  });
}
