import { NextRequest, NextResponse } from "next/server";
import {
  deleteWorkflow,
  getWorkflow,
  listWorkflows,
  saveWorkflow,
} from "@/lib/workflows/store";
import type { Workflow } from "@/lib/workflows/types";
import { ensureWorkflowApp } from "@/lib/workflows/install";

export const dynamic = "force-dynamic";

function deepMerge<T>(target: T, patch: unknown): T {
  if (patch == null || typeof patch !== "object") return target;
  if (Array.isArray(patch)) return patch as unknown as T;
  const out: Record<string, unknown> = { ...(target as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    const cur = out[k];
    if (v && typeof v === "object" && !Array.isArray(v) && cur && typeof cur === "object" && !Array.isArray(cur)) {
      out[k] = deepMerge(cur, v);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}

export async function GET(req: NextRequest) {
  await ensureWorkflowApp().catch(() => {});
  const id = new URL(req.url).searchParams.get("id");
  if (id) {
    const wf = await getWorkflow(id);
    if (!wf) return NextResponse.json({ error: `No workflow "${id}"` }, { status: 404 });
    return NextResponse.json({ workflow: wf });
  }
  return NextResponse.json({ workflows: await listWorkflows() });
}

export async function POST(req: NextRequest) {
  try {
    await ensureWorkflowApp().catch(() => {});
    const body = (await req.json()) as Workflow;
    if (!body.name) return NextResponse.json({ error: "name is required" }, { status: 400 });
    const wf = await saveWorkflow(body);
    return NextResponse.json({ workflow: wf });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}

export async function DELETE(req: NextRequest) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id query param required" }, { status: 400 });
  await deleteWorkflow(id);
  return NextResponse.json({ workflows: await listWorkflows() });
}

export async function PATCH(req: NextRequest) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id query param required" }, { status: 400 });
  let patch: unknown;
  try {
    patch = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const current = await getWorkflow(id);
  if (!current) return NextResponse.json({ error: `No workflow "${id}"` }, { status: 404 });
  const merged = deepMerge(current, patch);
  const saved = await saveWorkflow({ ...merged, id });
  return NextResponse.json({ workflow: saved });
}
