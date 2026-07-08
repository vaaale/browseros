import { NextRequest, NextResponse } from "next/server";
import path from "path";
import * as vfs from "@/os/vfs";

export const dynamic = "force-dynamic";

const ATTACHMENTS_DIR = "/Attachments";

export async function POST(req: NextRequest) {
  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json({ error: "Expected multipart/form-data" }, { status: 400 });
  }

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Missing file field" }, { status: 400 });
  }

  const ext = path.extname(file.name);
  const base = path.basename(file.name, ext).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
  const filename = `${Date.now()}-${base}${ext}`;
  const vfsPath = `${ATTACHMENTS_DIR}/${filename}`;

  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    await vfs.mkdir(ATTACHMENTS_DIR);
    await vfs.writeBuffer(vfsPath, buffer);
    const url = `/api/fs/raw?path=${encodeURIComponent(vfsPath)}`;
    return NextResponse.json({ url, mimeType: file.type, vfsPath });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
