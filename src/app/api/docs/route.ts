import { NextRequest, NextResponse } from "next/server";
import { listDocs, getDoc, saveDoc, removeDoc } from "@/lib/docs/store";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const id = new URL(req.url).searchParams.get("id");
  if (id) return NextResponse.json({ doc: await getDoc(id) });
  return NextResponse.json({ docs: await listDocs() });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    if (!body.title || !body.content) return NextResponse.json({ error: "title and content are required" }, { status: 400 });
    const doc = await saveDoc({ title: String(body.title), content: String(body.content) });
    return NextResponse.json({ doc });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}

export async function DELETE(req: NextRequest) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id query param required" }, { status: 400 });
  await removeDoc(id);
  return NextResponse.json({ docs: await listDocs() });
}
