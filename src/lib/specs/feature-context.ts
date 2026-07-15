import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { dataDir } from "@/os/data-dir";
import { writeFileAtomic } from "@/os/atomic-write";
import { AsyncMutex } from "@/os/async-mutex";
import { sanitizeFeatureId, branchForFeature } from "./feature-id";
import type { FeatureContext, FeatureContextFile } from "@/os/types";

// Server-authoritative single-writer for the active Feature Context
// (027-vfs-specfs). ALL mutations go through this module under one in-process
// mutex with atomic read-modify-write, so the client (whole-file intents) and
// SpecFS (touchedSpecs appends) can never race into a lost update.
//
// SpecFS reads the active context here (in-process) rather than over the wire,
// so server-side agent writes have no client→server ordering race.

function contextFile(): string {
  return path.join(dataDir(), "config", "feature-context.json");
}

const mutex = new AsyncMutex();

async function read(): Promise<FeatureContextFile> {
  try {
    const raw = await fs.readFile(contextFile(), "utf8");
    const parsed = JSON.parse(raw) as FeatureContextFile;
    return { active: parsed.active ?? null };
  } catch {
    return { active: null };
  }
}

async function write(file: FeatureContextFile): Promise<void> {
  await writeFileAtomic(contextFile(), JSON.stringify(file, null, 2));
}

// Optional Phase-2 hook: flush the outgoing feature and ensure the incoming
// feature's branch/worktree exist. Registered by SpecFS at startup; a no-op when
// this module runs alone (Phase 1). Kept as DI so Phase 1 does not depend on
// Phase 2.
export type ActivationHandler = (
  prev: FeatureContext | null,
  next: FeatureContext,
) => Promise<void>;

let activationHandler: ActivationHandler | null = null;
export function setActivationHandler(fn: ActivationHandler | null): void {
  activationHandler = fn;
}

/** The active Feature Context, or null. */
export async function getActive(): Promise<FeatureContext | null> {
  return (await read()).active;
}

/**
 * Make `id` the active feature (the one activation verb). Flushes the current
 * feature and ensures the target branch/worktree via the activation handler,
 * then records it active. "Start new" vs "resume existing" is a UI distinction;
 * both call this — the handler's branch/worktree step is create-or-reuse.
 */
export async function setActive(
  id: string,
  opts?: { description?: string },
): Promise<FeatureContext> {
  const cleanId = sanitizeFeatureId(id);
  return mutex.run(async () => {
    const current = (await read()).active;
    if (current?.id === cleanId) return current;
    const next: FeatureContext = {
      id: cleanId,
      branchName: branchForFeature(cleanId),
      description: opts?.description,
      touchedSpecs: [],
      touchedSourcePaths: [],
      startedAt: new Date().toISOString(),
    };
    if (activationHandler) await activationHandler(current, next);
    await write({ active: next });
    return next;
  });
}

/** Clear the active feature (e.g. after promote). */
export async function clear(): Promise<void> {
  return mutex.run(async () => {
    await write({ active: null });
  });
}

/**
 * Atomically read-modify-write the active context. Used by SpecFS/Developer-agent
 * wiring to append touched paths. Throws if no feature is active — a write with
 * no context is a caller error (no silent commit to a default branch).
 */
export async function patch(
  fn: (ctx: FeatureContext) => FeatureContext,
): Promise<FeatureContext> {
  return mutex.run(async () => {
    const current = (await read()).active;
    if (!current) throw new Error("No active feature context to patch");
    const next = fn(current);
    await write({ active: next });
    return next;
  });
}

/** Append a touched user-spec VFS path to the active context (dedup). */
export async function recordTouchedSpec(vfsPath: string): Promise<void> {
  await patch((ctx) =>
    ctx.touchedSpecs.includes(vfsPath)
      ? ctx
      : { ...ctx, touchedSpecs: [...ctx.touchedSpecs, vfsPath] },
  );
}

/** Append a touched BOS source path to the active context (dedup). */
export async function recordTouchedSource(sourcePath: string): Promise<void> {
  await patch((ctx) =>
    ctx.touchedSourcePaths.includes(sourcePath)
      ? ctx
      : { ...ctx, touchedSourcePaths: [...ctx.touchedSourcePaths, sourcePath] },
  );
}
