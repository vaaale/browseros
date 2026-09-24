// 046 T004 — register BOS's in-tree spec-kit pack (FR-008, FR-009 / ADR-1).
//
// A THIN SOURCE RESOLVER, not a second registration sequence. It answers one
// question — where is the built-in pack on disk — and hands the answer to the
// SAME sequence 045 FR-012 uses for a marketplace pack. SC-005 means "no second
// registration sequence", not "no new file".
//
// 045 FR-013a's origin gate never triggers here. It applies only to packs
// carrying a `plugin/` facet, and this one has none: the gate is not skipped,
// it does not apply.

import "server-only";
import { promises as fs, readFileSync } from "fs";
import path from "path";
import { registerMethod } from "./registry";
import { registerPackAgentRoot } from "@/lib/agent/subagents/roots";
import type { MethodManifest } from "./install";

export const BUILTIN_PACK_ID = "spec-kit";

/** Resolved against the RUNNING tree: a preview worktree has its own copy, and
 *  a pack read from base while code runs from the worktree would pair a
 *  feature branch's pipeline with base's templates. */
export function builtinPackRoot(): string {
  return path.join(process.cwd(), "seed", "method-packs", BUILTIN_PACK_ID);
}

/** The built-in descriptor, read from the pack's own method.json.
 *
 *  Synchronous on purpose: resolveMethod is a pure, sync function called from
 *  every store/Project resolution, and making it async to read one small JSON
 *  file at boot would ripple through the pipeline for no benefit. The file is
 *  in BOS's own tree, read once, and cached.
 *
 *  046 T006 deleted the TypeScript descriptor this replaces. Keeping it as a
 *  fallback would have moved the two-code-paths problem rather than removed it
 *  — the fallback is what would get read whenever the pack failed to load,
 *  which is exactly when you want to hear about it. */
let cached: MethodManifest | undefined;
export function loadBuiltinDescriptor(): MethodManifest {
  if (!cached) cached = JSON.parse(readFileSync(path.join(builtinPackRoot(), "method.json"), "utf8")) as MethodManifest;
  return cached;
}

/** Test-only: drop the cached descriptor. */
export function __resetBuiltinDescriptorForTest(): void {
  cached = undefined;
}

/** The running tree's revision, recorded in Provenance.version (FR-018) so a
 *  copied pack skill can be told apart from one seeded by an older tree. */
export function builtinPackVersion(manifest: MethodManifest): string {
  return process.env.BOS_VERSION_LABEL || manifest.version;
}

/** Register the in-tree pack: descriptor, agent root, template mount, and the
 *  dedicated skill-seeding step.
 *
 *  Idempotent — re-registration is how a pack upgrade lands, and unit tests
 *  call it directly rather than booting instrumentation. */
export async function registerBuiltinPack(): Promise<MethodManifest> {
  const root = builtinPackRoot();
  const manifest = loadBuiltinDescriptor();

  // Same call as a marketplace pack's install performs, with the pack root
  // recorded so pack-relative `templates`/`agentsDir` resolve against the pack
  // rather than against BOS's source tree.
  registerMethod(manifest, root);

  const agentsDir = path.join(root, manifest.agentsDir ?? "agents");
  if (await exists(agentsDir)) {
    registerPackAgentRoot({
      packId: manifest.id,
      path: agentsDir,
      label: manifest.label,
      visibility: manifest.agentVisibility ?? "picker",
    });
  }

  return manifest;
}

async function exists(p: string): Promise<boolean> {
  return fs.access(p).then(() => true).catch(() => false);
}
