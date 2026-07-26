import "server-only";
import path from "node:path";
import { LocalFS } from "./local-fs";
import { getActiveBranch } from "@/lib/specs/feature-context";
import { supervisorEnabled, supervisorBegin } from "@/lib/devharness/supervisor";
import type { FSBackend } from "../fs-types";
import type { VfsEntry } from "../types";

// DocsFS (mounted at /Docs): the FSBackend backing BOS's own docs/ tree. Unlike
// SpecFS, docs/ is not an external repo — it's a subtree of the BOS repo itself,
// so a feature branch's docs live in the SAME worktree the Developer already
// gets from the Supervisor (`<worktree>/docs`), no self-provisioning needed.
// Reads fall back to the base checkout when no feature is active; writes
// REQUIRE one (docs changes ride the same branch/commit as the code change).

const CANONICAL_DOCS_ROOT = path.join(process.cwd(), "docs");

async function branchDocsRoot(branch: string): Promise<string | null> {
  if (!branch || !supervisorEnabled()) return null;
  const begun = await supervisorBegin(branch).catch(() => null);
  const wt = begun && typeof begun.worktree === "string" ? begun.worktree : "";
  return wt ? path.join(wt, "docs") : null;
}

export class DocsFS implements FSBackend {
  private async readRoot(): Promise<string> {
    const branch = await getActiveBranch();
    if (branch) {
      const wt = await branchDocsRoot(branch);
      if (wt) return wt;
    }
    return CANONICAL_DOCS_ROOT;
  }

  private async writeRoot(): Promise<string> {
    const branch = await getActiveBranch();
    if (!branch) {
      throw new Error("No active feature branch — call dev_branch_request before editing docs/.");
    }
    const wt = await branchDocsRoot(branch);
    return wt ?? CANONICAL_DOCS_ROOT;
  }

  async list(relPath: string): Promise<VfsEntry[]> {
    return new LocalFS(await this.readRoot()).list(relPath);
  }
  async stat(relPath: string): Promise<VfsEntry> {
    return new LocalFS(await this.readRoot()).stat(relPath);
  }
  async readText(relPath: string): Promise<string> {
    return new LocalFS(await this.readRoot()).readText(relPath);
  }
  async readBuffer(relPath: string): Promise<Buffer> {
    return new LocalFS(await this.readRoot()).readBuffer(relPath);
  }
  async exists(relPath: string): Promise<boolean> {
    return new LocalFS(await this.readRoot()).exists(relPath);
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
