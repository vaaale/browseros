import { NextRequest, NextResponse } from "next/server";
import { status, createFeatureBranch, stageFiles } from "@/lib/system/git";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await status());
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    if (body.op === "branch") {
      if (!body.name) return NextResponse.json({ error: "name is required" }, { status: 400 });
      return NextResponse.json({ branch: await createFeatureBranch(String(body.name)) });
    }
    if (body.op === "stage") {
      const paths = Array.isArray(body.paths) ? body.paths.map(String) : [];
      return NextResponse.json({ staged: await stageFiles(paths) });
    }
    return NextResponse.json({ error: `Unknown op: ${body.op}` }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
