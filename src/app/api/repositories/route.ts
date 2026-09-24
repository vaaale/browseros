// 050 — the Repositories page's data (FR-010, FR-010a, FR-010b, FR-013).
//
// Everything the page shows is computed HERE: kind, branch, and whether a
// repository has uncommitted or unpushed work. Those are the two questions
// today's layout needs a click to answer, and they are the reason the page is
// organised by repository rather than by filesystem.

import "server-only";
import { NextRequest, NextResponse } from "next/server";
import path from "path";
import { promises as fs } from "fs";
import { execFile } from "child_process";
import { promisify } from "util";
import { specsRoot } from "@/os/specs-dir";
import { listStores } from "@/lib/specs/stores";
import { kindOf, bindingScopeOf } from "@/lib/specs/store-kind";
import { logger } from "@/lib/logging";

const exec = promisify(execFile);
const COMPONENT = "api.repositories";

export interface RepositoryRow {
  id: string;
  label: string;
  kind: string;
  bindingScope: string;
  root: string;
  repoRoot: string;
  branch?: string;
  /** The `bos/*` branches that EXIST here, whether or not one is checked out.
   *
   *  `branch` answers "what is checked out", which is the truth about state and
   *  is not the question someone asks of this page. They ask "which repositories
   *  does my feature touch" — and that question is how the over-branching bug
   *  was found, by reading a branch list by hand. */
  featureBranches?: string[];
  /** A feature branch in a repository that should never have one: the read-only
   *  system store, or a registered repository a branch was not scoped to.
   *  REPORTED, never deleted — some carry commits, and they are the user's. */
  strayBranches?: string[];
  /** Files changed but not committed. */
  uncommitted?: number;
  /** Commits on this branch that no remote has. */
  unpushed?: number;
  workflow?: string;
  /** Items in a marketplace repo. One repo, many independent products — the
   *  count is what makes "each item binds its own workflow" concrete. */
  itemCount?: number;
  writable: boolean;
  /** BOS's own stores cannot be removed (FR-007). */
  removable: boolean;
  /** A registered store whose symlink no longer resolves (FR-010b). Shown
   *  rather than hidden: discovery skips it by design, and a page that also
   *  hides it leaves a disappearance with no explanation. */
  broken?: boolean;
  /** Why this repository cannot be read — e.g. its method is not installed. */
  problem?: string;
  /** The workflow it is bound to is not installed. A distinct flag rather than
   *  something inferred from `problem`'s wording: the page offers a specific
   *  remedy for this case (open the Marketplace), and matching on prose to
   *  decide whether to show a button is how that button ends up on unrelated
   *  failures. */
  workflowMissing?: boolean;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd });
  return stdout.trim();
}

/** Branch + dirty/unpushed counts. Reported per repository rather than thrown:
 *  one unreadable repo must not blank the whole page, and the row says so. */
async function gitState(repoRoot: string): Promise<Partial<RepositoryRow>> {
  try {
    const branch = await git(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const status = await git(repoRoot, ["status", "--porcelain"]);
    const uncommitted = status ? status.split("\n").filter(Boolean).length : 0;

    // Commits this branch has that NO remote does. `--remotes` covers a branch
    // whose upstream is unset, which is the common case for a `bos/*` branch
    // that has never been pushed — reporting 0 there would be the dangerous
    // answer, since it is exactly the work a delete would lose.
    let unpushed = 0;
    try {
      const out = await git(repoRoot, ["rev-list", "--count", "HEAD", "--not", "--remotes"]);
      unpushed = Number(out) || 0;
    } catch {
      unpushed = 0; // no remotes configured at all
    }
    // Every bos/* ref here, so the page can answer "which repos does my feature
    // touch" rather than only "what is checked out".
    const listed = await git(repoRoot, ["for-each-ref", "--format=%(refname:short)", "refs/heads/bos/"]);
    const featureBranches = listed ? listed.split("\n").filter(Boolean).sort() : [];

    return { branch, uncommitted, unpushed, featureBranches };
  } catch (err) {
    logger().warn(COMPONENT, "could not read git state", { repoRoot, error: (err as Error).message });
    return { problem: `Could not read git state: ${(err as Error).message}` };
  }
}

/** Whether the workflow a repository is bound to is actually installed.
 *
 *  Reported per repository rather than thrown (045 FR-016): the content is
 *  intact, BOS simply cannot interpret it until the pack is installed, and a
 *  repository that vanished from the list instead would read as data loss. */
async function workflowProblem(storeId: string): Promise<Partial<RepositoryRow>> {
  try {
    const { methodForStore } = await import("@/lib/specs/pipeline");
    await methodForStore(storeId);
    return {};
  } catch (err) {
    return { workflowMissing: true, problem: (err as Error).message };
  }
}

/** How many items a marketplace repo holds.
 *
 *  Undefined when there is no manifest to read, which is a real state and not an
 *  error: a marketplace repo that has been registered but not yet populated has
 *  none. A malformed one IS reported — silently showing nothing would make a
 *  broken manifest look like an empty marketplace. */
async function marketplaceItemCount(repoRoot: string): Promise<number | undefined> {
  const manifestPath = path.join(repoRoot, "marketplace.json");
  let raw: string;
  try {
    raw = await fs.readFile(manifestPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    logger().warn(COMPONENT, "could not read a marketplace manifest", { manifestPath, error: (err as Error).message });
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as { items?: unknown };
    return Array.isArray(parsed.items) ? parsed.items.length : undefined;
  } catch (err) {
    logger().warn(COMPONENT, "marketplace manifest is not valid JSON", { manifestPath, error: (err as Error).message });
    return undefined;
  }
}

/** Registered names whose symlink no longer resolves. `listStores()` skips
 *  these — correctly, they cannot be read — so they are collected separately. */
async function brokenLinks(known: Set<string>): Promise<RepositoryRow[]> {
  const root = specsRoot();
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const out: RepositoryRow[] = [];
  for (const e of entries) {
    if (e.name.startsWith(".") || known.has(e.name)) continue;
    if (!e.isSymbolicLink()) continue;
    const link = path.join(root, e.name);
    if (await fs.stat(link).then(() => true).catch(() => false)) continue;
    const target = await fs.readlink(link).catch(() => "?");
    out.push({
      id: e.name,
      label: e.name,
      kind: "unknown",
      bindingScope: "none",
      root: link,
      repoRoot: target,
      writable: false,
      removable: true,
      broken: true,
      problem: `Its target no longer exists: ${target}`,
    });
  }
  return out;
}

/** The repositories BOS knows about that are NOT spec stores.
 *
 *  `user-apps` (the local marketplace) and `bos-src` (BrowserOS's own checkout)
 *  are real git repositories with real remotes, and neither has a spec store:
 *  a marketplace's stores are its ITEMS, and BOS's source is code, not specs. So
 *  `listStores()` has never yielded them and a page built from it alone showed
 *  neither — which, once remotes moved from one flat list into the repository
 *  rows, took their Pull/Push with it.
 *
 *  Discovered through `getAvailableGitFsInstances()` rather than named here: it
 *  is the existing "enumerate the roots, keep the ones that are git repos" scan
 *  (the same no-central-registry rule as spec-store discovery), so a future
 *  content root appears on this page for free. */
async function nonStoreRepositories(known: Set<string>): Promise<RepositoryRow[]> {
  const { getAvailableGitFsInstances, SOURCE_FS_ID } = await import("@/lib/gitops/filesystems");
  const out: RepositoryRow[] = [];
  for (const fs of await getAvailableGitFsInstances()) {
    if (known.has(fs.id)) continue;
    const isSource = fs.id === SOURCE_FS_ID;
    out.push({
      id: fs.id,
      label: fs.label,
      // A marketplace binds a workflow PER ITEM; BOS's source binds none at all,
      // because it is code rather than a spec store.
      kind: isSource ? "source" : "marketplace",
      bindingScope: isSource ? "none" : "project",
      root: fs.root,
      repoRoot: fs.root,
      ...(isSource ? {} : { itemCount: await marketplaceItemCount(fs.root) }),
      writable: true,
      // BOS's own. Removing either from here would break the running system,
      // and an action that always refuses is worse than no action (FR-007).
      removable: false,
      ...(await gitState(fs.root)),
    });
  }
  return out;
}

export async function GET() {
  const stores = await listStores();
  const rows: RepositoryRow[] = [];
  for (const s of stores) {
    // Item stores are PROJECTS inside their marketplace repo (049), not
    // repositories of their own — listing them here would show one repo a dozen
    // times.
    if (s.owner === "item") continue;
    const isBosOwn = s.owner === "system" || s.id === "user-specs";
    rows.push({
      id: s.id,
      label: s.label,
      kind: kindOf(s),
      bindingScope: bindingScopeOf(s),
      root: s.root,
      repoRoot: s.repoRoot,
      workflow: s.workflow ?? s.method,
      ...(kindOf(s) === "marketplace" ? { itemCount: await marketplaceItemCount(s.repoRoot) } : {}),
      writable: s.writable,
      removable: !isBosOwn,
      // Read for EVERY repository, read-only ones included: "does this have
      // unsaved work" is the question the page exists to answer at a glance,
      // and bos-system-specs having local changes is precisely the surprise
      // worth surfacing.
      ...(await gitState(s.repoRoot)),
      // AFTER gitState, so a missing workflow — the actionable one, with its own
      // remedy on the row — wins the single `problem` slot over a git hiccup.
      ...(await workflowProblem(s.id)),
    });
  }
  const known = new Set(rows.map((r) => r.id));
  rows.push(...(await nonStoreRepositories(known)));
  rows.push(...(await brokenLinks(new Set(stores.map((s) => s.id)))));

  // A feature branch in a repository that should never carry one. REPORTED, not
  // deleted: some carry commits, and all of them are the user's.
  //
  // Both cases were real before branches were scoped — `bos/agentic-editor-
  // appearance`, a change to ONE marketplace app, existed in the read-only
  // system store AND in an unrelated `police-mcp`.
  const { getBranchScope } = await import("@/lib/specs/branch-scope");
  for (const row of rows) {
    if (!row.featureBranches?.length) continue;

    if (row.writable === false) {
      row.strayBranches = row.featureBranches;
      continue;
    }
    if (row.kind !== "arbitrary") continue;

    // An arbitrary repository may legitimately hold a branch scoped TO it; only
    // the ones scoped elsewhere — or scoped to nothing — are stray.
    const stray: string[] = [];
    for (const b of row.featureBranches) {
      const scope = await getBranchScope(b);
      if (!scope || scope.kind !== "repository" || scope.repoId !== row.id) stray.push(b);
    }
    if (stray.length) row.strayBranches = stray;
  }

  return NextResponse.json({ repositories: rows });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const op = String(body.op ?? "");
    const { registerRepository, deregisterRepository, detectMethod } = await import("@/lib/specs/repositories");

    if (op === "detect") {
      return NextResponse.json({ method: await detectMethod(String(body.path ?? "")) });
    }
    if (op === "add") {
      const repo = await registerRepository({
        id: String(body.id ?? ""),
        label: body.label ? String(body.label) : undefined,
        kind: body.kind === "marketplace" ? "marketplace" : "arbitrary",
        url: body.url ? String(body.url) : undefined,
        provider: body.provider === "github" || body.provider === "gitlab" || body.provider === "generic" ? body.provider : undefined,
        workflow: body.workflow ? String(body.workflow) : undefined,
      });
      return NextResponse.json({ repository: repo });
    }
    if (op === "remove") {
      const mode = body.mode === "delete" ? "delete" : "forget";
      // FR-007: the caller must NAME which one. Defaulting to delete loses
      // work; defaulting to forget leaks disk. Neither is a safe assumption to
      // make on the user's behalf, so an unrecognised mode is not coerced.
      if (body.mode !== "delete" && body.mode !== "forget") {
        return NextResponse.json({ error: 'mode must be "forget" or "delete".' }, { status: 400 });
      }
      await deregisterRepository(String(body.id ?? ""), mode);
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: `Unknown op "${op}".` }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
