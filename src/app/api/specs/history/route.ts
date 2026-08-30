import { NextRequest, NextResponse } from "next/server";
import { resolveStoreRoot, storeRepoRelative, writeFile } from "@/lib/dev/spec-fs";
import { history } from "@/lib/gitfs/store";
import { readFileAtRef } from "@/lib/specs/store-git";

export const dynamic = "force-dynamic";

// File-history browsing + restore (037-project-layer, Phase 6). A store's
// content is versioned by ONE repo (`store.repoRoot`) with every draft `bos/*`
// branch as an additional ref in it, so history spans the whole store, not
// just the currently active worktree — and reading a historical version needs
// no checkout. Note repoRoot is not always the store root: an item-owned
// store's root is a subdirectory of the shared `user-apps` repo, so every git
// call here goes through repoRoot + storeRepoRelative(), never `store.root`.
// GET  /api/specs/history?path=<store/rel>          -> { history: [{hash,date,message}] }
// GET  /api/specs/history?path=<store/rel>&ref=<sha> -> { content }
// POST /api/specs/history { path, ref, branch? }     -> restore: write that version's
//                                                        content as a NEW commit (gated
//                                                        by the normal write rule — a real
//                                                        feature branch, for EVERY writable
//                                                        store including item-owned ones)
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const path = url.searchParams.get("path");
  const ref = url.searchParams.get("ref");
  if (!path) return NextResponse.json({ error: "path is required" }, { status: 400 });
  try {
    const { store, rel } = await resolveStoreRoot(path);
    const repoRel = storeRepoRelative(store, rel);
    if (ref) {
      const content = await readFileAtRef(store.repoRoot, ref, repoRel);
      return NextResponse.json({ content });
    }
    const entries = await history(store.repoRoot, repoRel, 100, { all: true });
    return NextResponse.json({ history: entries });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const path = String(body.path ?? "");
    const ref = String(body.ref ?? "");
    if (!path || !ref) return NextResponse.json({ error: "path and ref are required" }, { status: 400 });
    const branch = typeof body.branch === "string" && body.branch ? body.branch : undefined;
    const { store, rel } = await resolveStoreRoot(path);
    const content = await readFileAtRef(store.repoRoot, ref, storeRepoRelative(store, rel));
    const written = await writeFile(path, content, branch ? { branch } : undefined);
    return NextResponse.json({ path: written });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
