import { NextRequest, NextResponse } from "next/server";
import * as vfs from "@/os/vfs";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const op = searchParams.get("op") ?? "list";
  const p = searchParams.get("path") ?? "/";
  try {
    if (op === "list") return NextResponse.json({ entries: await vfs.list(p) });
    if (op === "read") return NextResponse.json({ content: await vfs.readText(p) });
    if (op === "stat") return NextResponse.json({ entry: await vfs.stat(p) });
    return NextResponse.json({ error: `Unknown op: ${op}` }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const op = String(body.op ?? "");
  try {
    switch (op) {
      case "write":
        await vfs.writeText(String(body.path), String(body.content ?? ""));
        return NextResponse.json({ ok: true });
      case "mkdir":
        await vfs.mkdir(String(body.path));
        return NextResponse.json({ ok: true });
      case "delete":
        await vfs.remove(String(body.path));
        return NextResponse.json({ ok: true });
      case "rename":
        await vfs.rename(String(body.path), String(body.to));
        return NextResponse.json({ ok: true });
      default:
        return NextResponse.json({ error: `Unknown op: ${op}` }, { status: 400 });
    }
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
