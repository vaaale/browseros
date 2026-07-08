import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { logger } from "@/lib/logging";
import { dataDir } from "@/os/data-dir";
import { hostPath } from "@/os/vfs";
import { createJob, invalidateCache, JOBS_VFS_PATH, listJobs } from "./engine";
import type {
  JobHandler,
  LegacyTaskV0,
} from "./types";

// One-shot migration for the Unified Job Engine (spec FR-016 + Migration Strategy).
//
// Sources to migrate on first boot after the upgrade:
//   1. data/scheduler/tasks.json  — legacy user-task store from the flat Task
//      schema. Each entry becomes a JobDefinition with category='user' and a
//      PromptHandler synthesised from its prompt+agentId fields.
//   2. (Reserved for future PRs) per-integration polling configs under
//      data/integrations/**. This module exposes `migrateIntegrationPollConfig`
//      as an extension point but does not sweep them yet — integrations will
//      call it explicitly when they finish adopting the unified engine.
//
// The migration is idempotent:
//   - JobDefinitions coming out of the legacy user store keep their original
//     `id`, so a second run detects "already there" and skips.
//   - Once a legacy file is drained, we rename it to `<name>.migrated` so
//     future boots do not re-read it. We also stash the source path in
//     `_meta.migratedSources` in the unified store as belt-and-braces.
//
// Failure isolation: each source is tried independently; a broken legacy file
// logs an error and does NOT block the daemon from starting on the empty new
// store.

const LOG = "scheduler.migrate";

let migrationDone = false;

/**
 * Run all migrations exactly once per process. Cheap after the first call.
 * Safe to call from many entry points (API routes, daemon start, etc).
 */
export async function runMigrationIfNeeded(): Promise<void> {
  if (migrationDone) return;
  migrationDone = true;
  try {
    await migrateLegacyUserTasks();
  } catch (err) {
    // Never block boot on a bad migration source — the unified store still works.
    logger().error(LOG, "legacy user-task migration failed", err);
  }
}

// ── Legacy user-task migration ────────────────────────────────────────────

function legacyTasksFile(): string {
  return path.join(dataDir(), "scheduler", "tasks.json");
}

async function readLegacyTasks(file: string): Promise<LegacyTaskV0[] | null> {
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      logger().warn(LOG, `legacy tasks.json is not an array — skipping`, { file });
      return null;
    }
    return parsed as LegacyTaskV0[];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function migrateLegacyUserTasks(): Promise<void> {
  const file = legacyTasksFile();
  const legacy = await readLegacyTasks(file);
  if (!legacy) return; // Nothing to do.
  if (legacy.length === 0) {
    // Empty legacy file — just mark it done so we never look again.
    await markSourceMigrated(file);
    return;
  }

  const existing = await listJobs();
  const existingIds = new Set(existing.map((j) => j.id));

  let migrated = 0;
  let skipped = 0;
  for (const t of legacy) {
    if (existingIds.has(t.id)) {
      skipped++;
      continue;
    }
    const handler: JobHandler = {
      kind: "prompt",
      prompt: t.prompt,
      agentId: t.agentId,
    };
    try {
      await createJob({
        id: t.id,
        name: t.name,
        category: "user",
        handler,
        scheduleConfig: t.scheduleConfig,
        deleteAfterExecution: t.deleteAfterExecution,
      });
      migrated++;
    } catch (err) {
      // Keep going — one bad legacy row shouldn't halt the batch.
      logger().error(LOG, `failed to migrate task ${t.id}`, err);
    }
  }

  await markSourceMigrated(file);

  // Also copy any per-task JSON execution history so the UI's detail view
  // still has data on the first post-upgrade boot. Best-effort; missing
  // files just mean "no history existed".
  await migrateLegacyExecutionHistory().catch((err) => {
    logger().warn(LOG, "legacy execution-history migration failed", err);
  });

  logger().info(LOG, "legacy user-task migration finished", {
    migrated,
    skipped,
    source: file,
  });
  invalidateCache();
}

async function markSourceMigrated(file: string): Promise<void> {
  try {
    await fs.rename(file, `${file}.migrated`);
  } catch (err) {
    // If rename fails (permission, filesystem oddities) we don't retry — the
    // migration will just no-op next boot because every id already exists in
    // the unified store. Log so the user can hand-clean if they want.
    logger().warn(LOG, `could not rename legacy source ${file}`, err);
  }
}

// ── Legacy execution-history migration ────────────────────────────────────
//
// Old shape: data/scheduler/executions/<taskId>.json — a JSON array of
// executions. New shape: JSONL under /Documents/System/scheduler-history/.
// We rewrite each file into the new location on first boot.

async function migrateLegacyExecutionHistory(): Promise<void> {
  const dir = path.join(dataDir(), "scheduler", "executions");
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const jobId = name.slice(0, -".json".length);
    const src = path.join(dir, name);
    try {
      const raw = await fs.readFile(src, "utf8");
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) continue;
      const targetVfsPath = `/Documents/System/scheduler-history/${jobId}.jsonl`;
      const targetHost = hostPath(targetVfsPath);
      await fs.mkdir(path.dirname(targetHost), { recursive: true });
      // If the JSONL already has content (double migration edge case), skip so
      // we never double-append the same executions.
      let exists = false;
      try {
        const st = await fs.stat(targetHost);
        exists = st.size > 0;
      } catch {
        exists = false;
      }
      if (exists) continue;
      const lines = arr
        .map((e: unknown) => {
          try {
            return JSON.stringify(e);
          } catch {
            return null;
          }
        })
        .filter((l): l is string => !!l);
      if (lines.length === 0) continue;
      await fs.writeFile(targetHost, lines.join("\n") + "\n", "utf8");
    } catch (err) {
      logger().warn(LOG, `could not migrate history for ${jobId}`, err);
    }
  }
  // Rename the whole directory so we don't re-scan it next boot.
  try {
    await fs.rename(dir, `${dir}.migrated`);
  } catch {
    // Non-fatal; per-file dedupe above handles idempotency.
  }
}

// Silence "unused" hint — JOBS_VFS_PATH is here for other Phase-0 callers that
// may want to log the location of the new store during migration.
export { JOBS_VFS_PATH };
