import "server-only";
import path from "node:path";
import { LocalFS } from "./local-fs";
import { getActiveBranch } from "@/lib/specs/feature-context";
import { supervisorEnabled, supervisorBeginOrThrow } from "@/lib/devharness/supervisor";
import { logger } from "@/lib/logging/server-logger";
import { isSection, sectionRoots } from "@/lib/docs/roots";
import type { FSBackend } from "../fs-types";
import type { VfsEntry } from "../types";

// DocsFS (mounted at /Docs): the FSBackend backing BOS's own docs/ tree. Unlike
// SpecFS, docs/ is not an external repo — it's a subtree of the BOS repo itself,
// so a feature branch's docs live in the SAME worktree the Developer already
// gets from the Supervisor (`<worktree>/docs`), no self-provisioning needed.
// Reads fall back to the base checkout when no feature is active; writes
// REQUIRE one (docs changes ride the same branch/commit as the code change).
//
// Reads under usage/ and dev/ also overlay each installed item's own
// `docs/<section>/` (src/lib/docs/roots.ts) — the SAME overlay
// src/lib/docs/store.ts applies for the Docs app's /api/docs tree. Without
// this, VFS-based tools (file_glob, file_search, the Files app) would see a
// different, narrower /Docs than the Docs app UI shows, and an installed
// item's documentation would be reachable only through the app, never through
// the VFS that's supposed to be the canonical entrypoint. Writes stay
// canonical-only below — an item's own docs ship with the item and aren't
// editable through this mount.

const CANONICAL_DOCS_ROOT = path.join(process.cwd(), "docs");
const COMPONENT = "docsfs";

export class DocsFS implements FSBackend {
  /** Falls back to the base checkout on any failure (not mounted yet, a
   *  Supervisor error, no branch) — a read landing on slightly stale docs is
   *  harmless. The failure is still logged so it's distinguishable from the
   *  normal "nothing written yet" case. */
  private async readRoot(): Promise<string> {
    const branch = await getActiveBranch();
    if (branch && supervisorEnabled()) {
      const wt = await supervisorBeginOrThrow(branch)
        .then(({ worktree }) => path.join(worktree, "docs"))
        .catch((err) => {
          logger().warn(COMPONENT, "supervisorBegin failed on read; falling back", { branch, err: String(err) });
          return null;
        });
      if (wt) return wt;
    }
    return CANONICAL_DOCS_ROOT;
  }

  /** Requires an active feature branch, and — under the Supervisor — its
   *  mounted worktree specifically. Silently writing to the base checkout
   *  instead (the prior behavior whenever the mount wasn't confirmed) would
   *  land docs changes on the wrong branch entirely with no indication
   *  anything went wrong; fail loudly instead. */
  private async writeRoot(): Promise<string> {
    const branch = await getActiveBranch();
    if (!branch) {
      throw new Error("No active feature branch — call dev_branch_request before editing docs/.");
    }
    if (!supervisorEnabled()) return CANONICAL_DOCS_ROOT;
    const { worktree } = await supervisorBeginOrThrow(branch);
    return path.join(worktree, "docs");
  }

  // The ordered (root, rest) candidates a read should try: the canonical docs
  // root (or active worktree's) always first, plus one entry per installed
  // item's `docs/<section>/` when relPath falls under usage/ or dev/. Matches
  // src/lib/docs/store.ts's sectionRoots() so both surfaces agree.
  private async candidatesFor(relPath: string): Promise<{ root: string; rest: string }[]> {
    const docsRoot = await this.readRoot();
    const cleaned = relPath.replace(/^[/\\]+/, "");
    if (!cleaned) return [{ root: docsRoot, rest: "" }];
    const [first, ...rest] = cleaned.split("/");
    if (!isSection(first)) return [{ root: docsRoot, rest: cleaned }];
    const restPath = rest.join("/");
    const roots = await sectionRoots(docsRoot, first);
    return roots.map((root) => ({ root, rest: restPath }));
  }

  async list(relPath: string): Promise<VfsEntry[]> {
    const candidates = await this.candidatesFor(relPath);
    if (candidates.length === 1) {
      const { root, rest } = candidates[0];
      return new LocalFS(root).list(rest);
    }
    const byName = new Map<string, VfsEntry>();
    for (const { root, rest } of candidates) {
      const entries = await new LocalFS(root).list(rest).catch(() => []);
      for (const e of entries) if (!byName.has(e.name)) byName.set(e.name, e);
    }
    return [...byName.values()].sort((a, b) =>
      a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1,
    );
  }

  async stat(relPath: string): Promise<VfsEntry> {
    const cleaned = relPath.replace(/^[/\\]+/, "");
    for (const { root, rest } of await this.candidatesFor(relPath)) {
      const entry = await new LocalFS(root).stat(rest).catch(() => null);
      if (entry) return rest ? entry : { ...entry, name: cleaned || "/" };
    }
    throw new Error(`ENOENT: ${relPath}`);
  }

  async readText(relPath: string): Promise<string> {
    for (const { root, rest } of await this.candidatesFor(relPath)) {
      const text = await new LocalFS(root).readText(rest).catch(() => null);
      if (text != null) return text;
    }
    throw new Error(`ENOENT: ${relPath}`);
  }

  async readBuffer(relPath: string): Promise<Buffer> {
    for (const { root, rest } of await this.candidatesFor(relPath)) {
      const buf = await new LocalFS(root).readBuffer(rest).catch(() => null);
      if (buf) return buf;
    }
    throw new Error(`ENOENT: ${relPath}`);
  }

  async exists(relPath: string): Promise<boolean> {
    for (const { root, rest } of await this.candidatesFor(relPath)) {
      if (await new LocalFS(root).exists(rest)) return true;
    }
    return false;
  }

  async writeText(relPath: string, content: string): Promise<void> {
    return new LocalFS(await this.writeRoot()).writeText(relPath, content);
  }
  async writeBuffer(relPath: string, data: Buffer): Promise<void> {
    return new LocalFS(await this.writeRoot()).writeBuffer(relPath, data);
  }
  async mkdir(relPath: string): Promise<void> {
    return new LocalFS(await this.writeRoot()).mkdir(relPath);
  }
  async remove(relPath: string): Promise<void> {
    return new LocalFS(await this.writeRoot()).remove(relPath);
  }
  async rename(fromRel: string, toRel: string): Promise<void> {
    return new LocalFS(await this.writeRoot()).rename(fromRel, toRel);
  }
}
