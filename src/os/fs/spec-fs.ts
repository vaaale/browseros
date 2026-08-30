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
import { STORE_MANIFEST, PROJECT_MANIFEST } from "@/lib/specs/stores";
import { boundDiff, deterministicMessage } from "./commit-message";
import { encodeBranchDir } from "@/lib/specs/feature-id";
import { getActiveBranch } from "@/lib/specs/feature-context";
import { supervisorEnabled, supervisorBeginOrThrow } from "@/lib/devharness/supervisor";
import { logger } from "@/lib/logging/server-logger";
import type { FSBackend } from "../fs-types";
import type { VfsEntry } from "../types";

// SpecFS (027-vfs-specfs): the FSBackend mounted at /Specs/<store-id> (one
// instance per spec store — user-specs and bos-system-specs).
//
// Root resolution: the 020 branch-coupled Feature Context (getActiveBranch) —
// the SAME `bos/*` feature branch used for BOS's own source code. Writes
// require an active one (SpecFSNoContextError otherwise); reads fall back to
// the base checkout when none is active. There is no separate per-Project
// git-activation mechanism (037-project-layer's lightweight flow, retired) —
// a genuine customization to BOS core eventually needs code, so the spec
// rides the same branch as the code, for both stores this class mounts.
// `bos-system-specs` is additionally read-only outright (see `writable`
// below) — it is never editable, branch or not.
//
// This is FRAGILE orchestration (git worktrees + a Supervisor that may hold the
// same branch), so the worktree-resolution and hand-off paths log at DEBUG.

const COMPONENT = "specfs";
const DEBOUNCE_MS = 2_000;

/** Thrown when a write is attempted with no active Feature Context. */
export class SpecFSNoContextError extends Error {
  constructor() {
    super(
      "No active feature context — start or resume a feature before writing to /Specs.",
    );
    this.name = "SpecFSNoContextError";
  }
}

/** Thrown when a write is attempted against a non-writable store
 *  (`bos-system-specs`) — refused unconditionally, regardless of any active
 *  feature branch. */
export class SpecFSReadOnlyError extends Error {
  constructor(storeId: string) {
    super(`Spec store "${storeId}" is read-only; it cannot be edited.`);
    this.name = "SpecFSReadOnlyError";
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
    /** Whether this store can be written to at all. `false` for
     *  bos-system-specs — every write throws SpecFSReadOnlyError regardless
     *  of any active feature branch. */
    private readonly writable: boolean,
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

  /** Where a WRITE on `branch` should land. Under the Supervisor, this is
   *  ALWAYS its mounted worktree (`<codeWorktree>/specs/<storeId>`) — never a
   *  self-provisioned one. Self-provisioning is reserved for standalone dev
   *  (no Supervisor at all); doing it under the Supervisor "just in case" the
   *  mount wasn't ready yet was itself the bug (see handOffSelfWorktree's
   *  doc comment) — a race where BOTH mechanisms `git worktree add` the SAME
   *  branch, and whichever loses fails with "already used by worktree"
   *  forever after, permanently splitting this store's content between two
   *  worktrees that no reader agrees on. Any stale self-worktree from before
   *  this fix (or from a Supervisor outage) is cleared FIRST so the
   *  Supervisor's own mount always gets a fair, uncontested attempt. */
  private async writeRoot(branch: string): Promise<string> {
    if (supervisorEnabled()) {
      await this.handOffSelfWorktree(branch);
      // Let a real failure here propagate with its actual cause (a broken
      // git credential, a network blip, a malformed response) rather than
      // being discarded and replaced by a generic guess — that guess is
      // exactly what turned a real "GitLab auth failed" production incident
      // into a misleading "may be busy, retry" message that retrying
      // couldn't actually fix.
      const { worktree, mountErrors } = await supervisorBeginOrThrow(branch);
      const supRoot = path.join(worktree, "specs", this.storeId);
      if (await SpecFS.dirExists(supRoot)) {
        logger().debug(COMPONENT, "using supervisor worktree", { branch, supRoot });
        return supRoot;
      }
      const cause = mountErrors?.[this.storeId] ?? "mount did not complete for an unknown reason";
      throw new Error(`Spec store "${this.storeId}" is not mounted on branch "${branch}": ${cause}`);
    }
    const wtPath = this.selfWorktreePath(branch);
    await ensureRepo(this.repoRoot);
    await ensureWorktree(this.repoRoot, wtPath, branch);
    return wtPath;
  }

  /** Clear a self-provisioned worktree so `git worktree add` (the Supervisor's
   *  mount, or a future retry) can't collide with it. Commits are on the
   *  branch ref itself, so flushing pending edits then pruning the worktree
   *  directory loses nothing — every commit remains reachable once the SAME
   *  branch is checked out elsewhere. */
  private async handOffSelfWorktree(branch: string): Promise<void> {
    const wtPath = this.selfWorktreePath(branch);
    if (!(await SpecFS.dirExists(wtPath))) return;
    logger().debug(COMPONENT, "clearing self worktree before supervisor mount", { branch, wtPath });
    await this.flushDir(`branch:${branch}`, wtPath).catch((err) =>
      logger().warn(COMPONENT, "hand-off flush failed", { branch, err: String(err) }),
    );
    await pruneWorktree(this.repoRoot, wtPath);
  }

  /** Where a READ resolves: the active Feature Context's worktree if
   *  materialized (shows pending writes), else the base checkout. Never
   *  provisions. Under the Supervisor, its mounted worktree is authoritative
   *  and checked first — a self-provisioned worktree is only ever consulted
   *  as a fallback (legacy state from before a fix to writeRoot, or the
   *  Supervisor being transiently unavailable), never preferred over it. */
  private async readRoot(): Promise<string> {
    const branch = await getActiveBranch();
    if (!branch) return this.repoRoot;
    if (supervisorEnabled()) {
      // A read intentionally falls back to the base checkout when nothing's
      // mounted yet (an unwritten branch is a normal, expected state) — but
      // that fallback must not also swallow a REAL failure (auth, network)
      // without a trace, or a genuinely broken mount looks identical to "not
      // written yet" in every log.
      const supRoot = await supervisorBeginOrThrow(branch)
        .then(({ worktree }) => path.join(worktree, "specs", this.storeId))
        .catch((err) => {
          logger().warn(COMPONENT, "supervisorBegin failed on read; falling back", { branch, err: String(err) });
          return "";
        });
      if (supRoot && (await SpecFS.dirExists(supRoot))) return supRoot;
    }
    const self = this.selfWorktreePath(branch);
    if (await SpecFS.dirExists(self)) return self;
    return this.repoRoot; // branch not materialized yet → base
  }

  /** Refused outright for a non-writable store, regardless of branch.
   *  Otherwise requires an active Feature Context (the same `bos/*` branch
   *  used for BOS's own source) — throws SpecFSNoContextError without one. */
  private async requireWriteBackend(): Promise<{ backend: LocalFS; commitKey: string; root: string }> {
    if (!this.writable) throw new SpecFSReadOnlyError(this.storeId);
    const branch = await getActiveBranch();
    if (!branch) throw new SpecFSNoContextError();
    const root = await this.writeRoot(branch);
    return { backend: new LocalFS(root), commitKey: `branch:${branch}`, root };
  }

  private async readBackend(): Promise<LocalFS> {
    await this.maybeStartupSweep();
    return new LocalFS(await this.readRoot());
  }

  // ---- commit scheduling ---------------------------------------------------

  private schedule(commitKey: string, root: string): void {
    const existing = this.pending.get(commitKey);
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => {
      void this.flushDir(commitKey, root).catch((err) =>
        logger().error(COMPONENT, "debounced commit failed", err, { commitKey, root }),
      );
    }, DEBOUNCE_MS);
    (timer as { unref?: () => void }).unref?.();
    this.pending.set(commitKey, { timer, root });
  }

  private async flushDir(commitKey: string, root: string): Promise<void> {
    const p = this.pending.get(commitKey);
    if (p) {
      clearTimeout(p.timer);
      this.pending.delete(commitKey);
    }
    if (!(await hasUncommitted(root))) return;
    const message = await this.buildCommitMessage(root);
    await commit(root, message);
  }

  /** Force any pending writes for `branch` to commit now. Precondition for any
   *  read of the branch's COMMITTED state (e.g. promote) — branch-keyed,
   *  matching the 020 promote flow this exists for. */
  async flushPending(branch: string): Promise<void> {
    const commitKey = `branch:${branch}`;
    const p = this.pending.get(commitKey);
    const root = p?.root ?? this.selfWorktreePath(branch);
    if (!(await SpecFS.dirExists(root))) return;
    await this.flushDir(commitKey, root);
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
    // Hide git internals and the store/Project manifests from the file view
    // (matches the pre-027 spec listing behaviour, extended for Projects).
    return entries.filter((e) => !e.name.startsWith(".") && e.name !== STORE_MANIFEST && e.name !== PROJECT_MANIFEST);
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

  // ---- FSBackend: writes (require a writable store + an active Feature Context) ----

  async writeText(relPath: string, content: string): Promise<void> {
    const { backend, commitKey, root } = await this.requireWriteBackend();
    await backend.writeText(relPath, content);
    this.schedule(commitKey, root);
  }
  async writeBuffer(relPath: string, data: Buffer): Promise<void> {
    const { backend, commitKey, root } = await this.requireWriteBackend();
    await backend.writeBuffer(relPath, data);
    this.schedule(commitKey, root);
  }
  async mkdir(relPath: string): Promise<void> {
    const { backend } = await this.requireWriteBackend();
    await backend.mkdir(relPath);
  }
  async remove(relPath: string): Promise<void> {
    const { backend, commitKey, root } = await this.requireWriteBackend();
    await backend.remove(relPath);
    this.schedule(commitKey, root);
  }
  async rename(fromRel: string, toRel: string): Promise<void> {
    const { backend, commitKey, root } = await this.requireWriteBackend();
    await backend.rename(fromRel, toRel);
    this.schedule(commitKey, root);
  }

  // ---- lifecycle hooks used by the mount initializer -----------------------

  /** Public entry to the one-time crash-recovery sweep (run at mount time). */
  async runStartupSweep(): Promise<void> {
    await this.maybeStartupSweep();
  }
}
