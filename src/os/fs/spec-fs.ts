import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";
import { LocalFS } from "./local-fs";
import {
  ensureWorktree,
  pruneWorktree,
  listWorktrees,
  hasUncommitted,
  commit,
  workingDiff,
} from "./git-fs";
import { ensureRepo } from "@/lib/gitfs/store";
import { STORE_MANIFEST } from "@/lib/specs/stores";
import { boundDiff, deterministicMessage } from "./commit-message";
import { encodeBranchDir } from "@/lib/specs/feature-id";
import { getActiveBranch } from "@/lib/specs/feature-context";
import { supervisorEnabled, supervisorBegin } from "@/lib/devharness/supervisor";
import { logger } from "@/lib/logging/server-logger";
import type { FSBackend } from "../fs-types";
import type { VfsEntry } from "../types";

// SpecFS (027-vfs-specfs): the FSBackend mounted at Documents/Specs, backing the
// user spec store. It ADOPTS the 020 branch-coupled worktree model rather than
// forking it — NO base `git checkout`, ever:
//   * Writes require an active Feature Context and land in a WORKTREE on that
//     feature's branch (Supervisor-provisioned when a preview exists, else a
//     SpecFS-self-provisioned worktree under <worktreesBase>).
//   * Reads come from the active worktree (so uncommitted writes are visible),
//     or the base checkout when no feature is active.
//   * Commits are debounced and coalesced; a promote/flush forces them out.
//
// This is FRAGILE orchestration (git worktrees + a Supervisor that may hold the
// same branch), so the worktree-resolution and hand-off paths log at DEBUG.

const COMPONENT = "specfs";
const DEBOUNCE_MS = 2_000;

/** Thrown when a write is attempted with no active Feature Context. */
export class SpecFSNoContextError extends Error {
  constructor() {
    super(
      "No active feature context — start or resume a feature before writing to Documents/Specs.",
    );
    this.name = "SpecFSNoContextError";
  }
}

/** Optional DI seam for an LLM-generated commit message (027 spec). When unset,
 *  a deterministic message is used. Kept as a hook so wiring the model client is
 *  an isolated, non-blocking change and a model outage always degrades to the
 *  deterministic fallback. */
export type CommitMessageFn = (diff: string) => Promise<string>;

interface PendingCommit {
  timer: ReturnType<typeof setTimeout>;
  root: string;
}

export class SpecFS implements FSBackend {
  private readonly pending = new Map<string, PendingCommit>();
  private commitMessageFn: CommitMessageFn | null = null;
  private sweptOnce = false;

  constructor(
    /** The user spec store repo (data/specs/user). */
    private readonly repoRoot: string,
    /** Store id, used for the Supervisor worktree mount path (…/specs/<id>). */
    private readonly storeId: string,
    /** Base dir for self-provisioned worktrees (data/specs/.worktrees). */
    private readonly worktreesBase: string,
  ) {}

  setCommitMessageFn(fn: CommitMessageFn | null): void {
    this.commitMessageFn = fn;
  }

  // ---- root resolution -----------------------------------------------------

  private selfWorktreePath(branch: string): string {
    return path.join(this.worktreesBase, encodeBranchDir(branch));
  }

  private static async dirExists(dir: string): Promise<boolean> {
    return fs.access(dir).then(() => true).catch(() => false);
  }

  /** Where a WRITE on `branch` should land (provisioning the worktree). Prefers
   *  the Supervisor's worktree; otherwise self-provisions. Includes the N1
   *  hand-off: if a Supervisor worktree appears for a branch we previously
   *  self-provisioned, flush + prune ours first. */
  private async writeRoot(branch: string): Promise<string> {
    if (supervisorEnabled()) {
      const begun = await supervisorBegin(branch).catch((err) => {
        logger().debug(COMPONENT, "supervisorBegin failed; using self worktree", {
          branch,
          err: String(err),
        });
        return null;
      });
      const wt = begun && typeof begun.worktree === "string" ? begun.worktree : "";
      if (wt) {
        const supRoot = path.join(wt, "specs", this.storeId);
        if (await SpecFS.dirExists(supRoot)) {
          await this.handOffSelfWorktree(branch);
          logger().debug(COMPONENT, "using supervisor worktree", { branch, supRoot });
          return supRoot;
        }
        logger().debug(COMPONENT, "supervisor worktree lacks store dir; self-provisioning", {
          branch,
          supRoot,
        });
      }
    }
    const wtPath = this.selfWorktreePath(branch);
    await ensureRepo(this.repoRoot);
    await ensureWorktree(this.repoRoot, wtPath, branch);
    return wtPath;
  }

  /** N1 hand-off: flush + prune a self-provisioned worktree once the Supervisor
   *  owns the branch, so `git worktree add` can't collide. Commits are on the
   *  branch ref, so pruning the worktree loses nothing. */
  private async handOffSelfWorktree(branch: string): Promise<void> {
    const wtPath = this.selfWorktreePath(branch);
    if (!(await SpecFS.dirExists(wtPath))) return;
    logger().debug(COMPONENT, "N1 hand-off: flushing + pruning self worktree", { branch, wtPath });
    await this.flushDir(branch, wtPath).catch((err) =>
      logger().warn(COMPONENT, "hand-off flush failed", { branch, err: String(err) }),
    );
    await pruneWorktree(this.repoRoot, wtPath);
  }

  /** Where a READ resolves: the active worktree if materialized (shows pending
   *  writes), else the base checkout. Never provisions. */
  private async readRoot(): Promise<string> {
    const branch = await getActiveBranch();
    if (!branch) return this.repoRoot;
    const self = this.selfWorktreePath(branch);
    if (await SpecFS.dirExists(self)) return self;
    if (supervisorEnabled()) {
      const begun = await supervisorBegin(branch).catch(() => null);
      const wt = begun && typeof begun.worktree === "string" ? begun.worktree : "";
      const supRoot = wt ? path.join(wt, "specs", this.storeId) : "";
      if (supRoot && (await SpecFS.dirExists(supRoot))) return supRoot;
    }
    return this.repoRoot; // branch not materialized yet → base
  }

  private async requireWriteBackend(): Promise<{ backend: LocalFS; branch: string; root: string }> {
    const branch = await getActiveBranch();
    if (!branch) throw new SpecFSNoContextError();
    const root = await this.writeRoot(branch);
    return { backend: new LocalFS(root), branch, root };
  }

  private async readBackend(): Promise<LocalFS> {
    await this.maybeStartupSweep();
    return new LocalFS(await this.readRoot());
  }

  // ---- commit scheduling ---------------------------------------------------

  private schedule(branch: string, root: string): void {
    const existing = this.pending.get(branch);
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => {
      void this.flushDir(branch, root).catch((err) =>
        logger().error(COMPONENT, "debounced commit failed", err, { branch, root }),
      );
    }, DEBOUNCE_MS);
    (timer as { unref?: () => void }).unref?.();
    this.pending.set(branch, { timer, root });
  }

  private async flushDir(branch: string, root: string): Promise<void> {
    const p = this.pending.get(branch);
    if (p) {
      clearTimeout(p.timer);
      this.pending.delete(branch);
    }
    if (!(await hasUncommitted(root))) return;
    const message = await this.buildCommitMessage(root);
    await commit(root, message);
  }

  /** Force any pending writes for `branch` to commit now. Precondition for any
   *  read of the branch's COMMITTED state (e.g. promote). */
  async flushPending(branch: string): Promise<void> {
    const p = this.pending.get(branch);
    const root = p?.root ?? this.selfWorktreePath(branch);
    if (!(await SpecFS.dirExists(root))) return;
    await this.flushDir(branch, root);
  }

  private async buildCommitMessage(root: string): Promise<string> {
    const diff = await workingDiff(root).catch(() => "");
    const bounded = boundDiff(diff);
    if (this.commitMessageFn) {
      try {
        const msg = (await this.commitMessageFn(bounded)).trim();
        if (msg) return msg.slice(0, 200);
      } catch (err) {
        logger().debug(COMPONENT, "LLM commit message failed; using fallback", { err: String(err) });
      }
    }
    return deterministicMessage(bounded);
  }

  /** Crash recovery (N-review): sweep uncommitted worktree state into a recovery
   *  commit so a crash inside the debounce window never silently loses edits. */
  private async maybeStartupSweep(): Promise<void> {
    if (this.sweptOnce) return;
    this.sweptOnce = true;
    try {
      await ensureRepo(this.repoRoot);
      const roots = [this.repoRoot, ...(await listWorktrees(this.repoRoot))];
      for (const root of roots) {
        if (await hasUncommitted(root)) {
          logger().debug(COMPONENT, "startup sweep: committing recovered edits", { root });
          await commit(root, "chore: recover uncommitted spec edits (startup sweep)");
        }
      }
    } catch (err) {
      logger().warn(COMPONENT, "startup sweep failed", { err: String(err) });
    }
  }

  // ---- FSBackend: reads ----------------------------------------------------

  async list(relPath: string): Promise<VfsEntry[]> {
    const entries = await (await this.readBackend()).list(relPath).catch(() => []);
    // Hide git internals and the store manifest from the file view (matches the
    // pre-027 spec listing behaviour).
    return entries.filter((e) => !e.name.startsWith(".") && e.name !== STORE_MANIFEST);
  }
  async stat(relPath: string): Promise<VfsEntry> {
    return (await this.readBackend()).stat(relPath);
  }
  async readText(relPath: string): Promise<string> {
    return (await this.readBackend()).readText(relPath);
  }
  async readBuffer(relPath: string): Promise<Buffer> {
    return (await this.readBackend()).readBuffer(relPath);
  }
  async exists(relPath: string): Promise<boolean> {
    return (await this.readBackend()).exists(relPath);
  }

  // ---- FSBackend: writes (require an active Feature Context) ---------------

  async writeText(relPath: string, content: string): Promise<void> {
    const { backend, branch, root } = await this.requireWriteBackend();
    await backend.writeText(relPath, content);
    this.schedule(branch, root);
  }
  async writeBuffer(relPath: string, data: Buffer): Promise<void> {
    const { backend, branch, root } = await this.requireWriteBackend();
    await backend.writeBuffer(relPath, data);
    this.schedule(branch, root);
  }
  async mkdir(relPath: string): Promise<void> {
    const { backend } = await this.requireWriteBackend();
    await backend.mkdir(relPath);
  }
  async remove(relPath: string): Promise<void> {
    const { backend, branch, root } = await this.requireWriteBackend();
    await backend.remove(relPath);
    this.schedule(branch, root);
  }
  async rename(fromRel: string, toRel: string): Promise<void> {
    const { backend, branch, root } = await this.requireWriteBackend();
    await backend.rename(fromRel, toRel);
    this.schedule(branch, root);
  }

  // ---- lifecycle hooks used by the mount initializer -----------------------

  /** Public entry to the one-time crash-recovery sweep (run at mount time). */
  async runStartupSweep(): Promise<void> {
    await this.maybeStartupSweep();
  }
}
