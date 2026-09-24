// 050 — registering a repository (FR-001 … FR-009).
//
// NO REGISTRY FILE, deliberately. Stores are already discovered by scanning
// BOS_SPECS_ROOT for a `spec-store.json`, symlinks included. A `repositories.json`
// beside that scan would be a SECOND source of truth about which repositories
// exist, and two lists that can disagree is the shape of every "my repo
// vanished" report. Registration therefore writes exactly what the scan reads:
//
//     clone or init  ->  ensure the store root  ->  write the manifest  ->  symlink
//
// Every step is inspectable on disk, and removing the symlink is a complete
// deregistration.

import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { specsRoot } from "@/os/specs-dir";
import { dataDir } from "@/os/data-dir";
import { logger } from "@/lib/logging";
import { listStores, STORE_MANIFEST, type StoreManifest } from "./stores";

const exec = promisify(execFile);
const COMPONENT = "specs.repositories";

/** Where BOS puts repositories it clones or creates. A repository the user
 *  already has elsewhere is reached by symlink and never moved. */
export const repositoriesDir = () => path.join(dataDir(), "repositories");

export type RepositoryKind = "arbitrary" | "marketplace";

export interface RegisterInput {
  /** Directory name under the specs root, and the store id. */
  id: string;
  label?: string;
  kind: RepositoryKind;
  /** Clone this URL, or omit to `git init` an empty repository. */
  url?: string;
  /** Which host the URL belongs to, so pull/push can find the right
   *  credentials. Omitted ⇒ detected from the URL. */
  provider?: "github" | "gitlab" | "generic";
  /** Workflow to bind. Omitted ⇒ the global default. */
  workflow?: string;
}

export interface RegisteredRepository {
  id: string;
  repoRoot: string;
  storeRoot: string;
  kind: RepositoryKind;
  workflow?: string;
}

/** Which host a URL belongs to, so pull/push find the right credentials.
 *  github.com / gitlab.com are recognised; anything else authenticates with a
 *  per-remote token rather than provider-wide OAuth. */
export function detectProvider(url: string): "github" | "gitlab" | "generic" {
  const u = url.toLowerCase();
  if (u.includes("github.com")) return "github";
  if (u.includes("gitlab.com") || u.includes("gitlab.")) return "gitlab";
  return "generic";
}

function isSafeId(id: string): boolean {
  return /^[a-z0-9][a-z0-9._-]*$/i.test(id) && !id.includes("..");
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Normalise a git URL enough to compare two spellings of one remote.
 *
 *  `git@host:owner/repo.git` and `https://host/owner/repo` are the same
 *  repository, and registering both produces two stores over one worktree. */
function sameRemote(a: string, b: string): boolean {
  const norm = (u: string) =>
    u.trim().toLowerCase()
      .replace(/\.git$/, "")
      .replace(/^git@([^:]+):/, "$1/")
      .replace(/^[a-z+]+:\/\//, "")
      .replace(/\/+$/, "");
  return norm(a) === norm(b);
}

/** Which method a repository already uses, judged by its own layout.
 *
 *  OFFERED, never applied silently (FR-004, `design.md` R4): a repo that
 *  already has an `openspec/` folder is using OpenSpec, and imposing the
 *  default over it would write a second, unrelated spec tree beside the real
 *  one. Detection can be wrong, so the caller preselects rather than decides. */
export async function detectMethod(repoRoot: string): Promise<string | undefined> {
  const { listMethods } = await import("./method/registry");
  for (const m of listMethods()) {
    // `"."` — the method writes at the repo root — is not detectable, because
    // every repository has a root. Skipped for that reason and no other: a
    // descriptor that merely OMITTED storeRoot cannot reach here any more
    // (registerMethod refuses it), which is what made this skip silent.
    if (m.storeRoot === ".") continue;
    if (await pathExists(path.join(repoRoot, m.storeRoot))) return m.id;
  }
  return undefined;
}

/** The branch a fresh clone landed on — i.e. the remote's default branch.
 *
 *  Read from `refs/remotes/origin/HEAD` first, which is what the remote SAYS its
 *  default is, and only then from the local checkout. The two agree immediately
 *  after a clone and stop agreeing the moment BOS moves to a feature branch, so
 *  preferring the remote's answer keeps this correct if it is ever called later.
 *
 *  Undefined on failure rather than a guess: pull/push already fall back to the
 *  current branch, and recording a wrong default would send a push somewhere the
 *  user never chose. */
async function clonedDefaultBranch(repoRoot: string): Promise<string | undefined> {
  try {
    const { stdout } = await exec("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { cwd: repoRoot });
    const ref = stdout.trim();
    if (ref.startsWith("origin/")) return ref.slice("origin/".length);
  } catch {
    // No origin/HEAD — normal for a clone of an empty repo, and for some
    // servers. The checkout below still answers.
  }
  try {
    const { stdout } = await exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repoRoot });
    const branch = stdout.trim();
    return branch && branch !== "HEAD" ? branch : undefined;
  } catch (err) {
    logger().warn(COMPONENT, "could not determine the cloned default branch", { repoRoot, error: (err as Error).message });
    return undefined;
  }
}

async function assertNotAlreadyRegistered(input: RegisterInput, repoRoot: string): Promise<void> {
  const stores = await listStores();
  if (stores.some((s) => s.id === input.id)) {
    throw new Error(`A repository is already registered as "${input.id}".`);
  }

  // By RESOLVED PATH as well as by id: the same checkout reached under two
  // names is two jails over one worktree, each committing over the other's
  // branch state (FR-008).
  const resolved = await fs.realpath(repoRoot).catch(() => repoRoot);
  for (const s of stores) {
    const other = await fs.realpath(s.repoRoot).catch(() => s.repoRoot);
    if (other === resolved) {
      throw new Error(`That repository is already registered as "${s.id}".`);
    }
    // FR-009: nesting is the same corruption with extra steps — two stores
    // writing one worktree, one of them unaware of the other's branch.
    const rel = path.relative(other, resolved);
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
      throw new Error(`That path is inside "${s.id}", which is already registered. Nested repositories are not supported.`);
    }
    const back = path.relative(resolved, other);
    if (back && !back.startsWith("..") && !path.isAbsolute(back)) {
      throw new Error(`"${s.id}" is already registered INSIDE that path. Nested repositories are not supported.`);
    }
  }
}

async function remoteAlreadyRegistered(url: string): Promise<string | undefined> {
  for (const s of await listStores()) {
    const { stdout } = await exec("git", ["remote", "-v"], { cwd: s.repoRoot }).catch(() => ({ stdout: "" }));
    for (const line of stdout.split("\n")) {
      const u = line.split(/\s+/)[1];
      if (u && sameRemote(u, url)) return s.id;
    }
  }
  return undefined;
}

/** Register a repository: clone it or create it, then make it discoverable.
 *
 *  On ANY failure this leaves nothing behind (FR-006). A half-registered
 *  repository is worse than a failed one because it looks like success and
 *  blocks the retry. */
export async function registerRepository(input: RegisterInput): Promise<RegisteredRepository> {
  if (!isSafeId(input.id)) throw new Error(`"${input.id}" is not a valid repository id.`);

  const repoRoot = path.join(repositoriesDir(), input.id);
  const created: string[] = [];

  if (input.url) {
    const clash = await remoteAlreadyRegistered(input.url);
    if (clash) throw new Error(`That repository is already registered as "${clash}".`);
  }
  if (await pathExists(repoRoot)) {
    throw new Error(`${repoRoot} already exists. Remove it first, or choose another id.`);
  }

  try {
    await fs.mkdir(repositoriesDir(), { recursive: true });

    if (input.url) {
      await exec("git", ["clone", "--", input.url, repoRoot]);
    } else {
      await fs.mkdir(repoRoot, { recursive: true });
      await exec("git", ["init", "-q"], { cwd: repoRoot });
    }
    created.push(repoRoot);

    await assertNotAlreadyRegistered(input, repoRoot);

    // The method decides where specs live, so its own CLI keeps working on the
    // same checkout (FR-003). `"."` — or no workflow chosen yet — is the repo
    // root itself.
    const { resolveWorkflow } = await import("./method/workflows");
    const wf = input.workflow ? resolveWorkflow(input.workflow) : undefined;
    const offset = wf?.method.storeRoot;
    const storeRoot = offset && offset !== "." ? path.join(repoRoot, offset) : repoRoot;
    await fs.mkdir(storeRoot, { recursive: true });

    const manifest: StoreManifest = {
      label: input.label?.trim() || input.id,
      owner: input.kind === "marketplace" ? "marketplace" : "user",
      writable: true,
      requiresPromote: false,
      kind: input.kind,
      ...(wf ? { workflow: wf.qualified } : {}),
    };
    await fs.writeFile(path.join(storeRoot, STORE_MANIFEST), JSON.stringify(manifest, null, 2) + "\n");

    // FR-005: an unborn HEAD is not a usable store — it surfaces later as
    // unrelated git errors from operations that assume a commit exists.
    await exec("git", ["add", "-A"], { cwd: repoRoot });
    const { stdout: staged } = await exec("git", ["status", "--porcelain"], { cwd: repoRoot });
    if (staged.trim()) {
      await exec("git", ["-c", "user.name=BrowserOS", "-c", "user.email=bos@local", "commit", "-q", "-m", "Register with BrowserOS"], { cwd: repoRoot });
    }

    await fs.mkdir(specsRoot(), { recursive: true });
    const link = path.join(specsRoot(), input.id);
    await fs.symlink(storeRoot, link, "dir");
    created.push(link);

    // Record the clone's remote so pull/push authenticate the same way every
    // other remote does — credentials are provider-wide and configured once in
    // Settings -> Integrations -> Git Providers. Without this the repository
    // clones fine and then cannot fetch, which reads as a broken repo rather
    // than as missing credentials.
    if (input.url) {
      try {
        const { addRemoteConfig, removeRemoteConfigsForFilesystem } = await import("@/lib/gitops/remote-config");
        const provider = input.provider ?? detectProvider(input.url);
        // Nothing under this id can legitimately pre-date a registration that
        // just created the checkout, so anything here is residue from an earlier
        // one. Left in place it does not merely clutter: `getUniqueRemoteName`
        // counts it, so this remote would be named `origin-2`, and "the remote
        // called origin" would then resolve to the dead entry.
        const stale = removeRemoteConfigsForFilesystem(input.id);
        if (stale > 0) {
          logger().info(COMPONENT, "cleared remote configs left by an earlier registration", { id: input.id, count: stale });
        }
        addRemoteConfig({
          name: "origin",
          url: input.url,
          provider,
          authType: provider === "generic" ? "token" : "oauth",
          autoPush: false,
          filesystem: input.id,
          // The branch `git clone` actually checked out — the remote's own
          // default. Recorded now because this is the one moment it is known for
          // free; every later reader would have to ask the remote again, and
          // pull/push fall back to whatever happens to be checked out locally,
          // which stops being the remote's default the first time BOS moves to
          // a feature branch.
          defaultBranch: await clonedDefaultBranch(repoRoot),
        });
      } catch (err) {
        // The clone succeeded; only the credential binding did not. Report it —
        // the user needs to know why the next pull will ask for a password.
        logger().warn(COMPONENT, "registered, but could not record the remote's provider", {
          id: input.id,
          error: (err as Error).message,
        });
      }
    }

    logger().info(COMPONENT, "repository registered", { id: input.id, repoRoot, storeRoot, kind: input.kind });
    return { id: input.id, repoRoot, storeRoot, kind: input.kind, workflow: wf?.qualified };
  } catch (err) {
    // Roll back in reverse. Reported, not swallowed: a cleanup that also fails
    // leaves residue a retry will trip over, and the user needs to know which.
    for (const p of created.reverse()) {
      await fs.rm(p, { recursive: true, force: true }).catch((rmErr) => {
        logger().error(COMPONENT, "could not clean up after a failed registration", undefined, {
          path: p,
          error: (rmErr as Error).message,
        });
      });
    }
    throw err;
  }
}

/** Stop tracking a repository. FORGET leaves the working copy; DELETE removes
 *  it. Named separately on purpose (FR-007): defaulting to delete loses work,
 *  defaulting to forget silently leaks disk, and a single "remove" is one of
 *  those two by accident. */
export async function deregisterRepository(id: string, mode: "forget" | "delete"): Promise<void> {
  const store = (await listStores()).find((s) => s.id === id);
  if (!store) throw new Error(`No repository registered as "${id}".`);
  if (store.owner === "system" || id === "user-specs") {
    throw new Error(`"${id}" is one of BrowserOS's own stores and cannot be removed.`);
  }

  const link = path.join(specsRoot(), id);
  await fs.rm(link, { recursive: true, force: true });

  // For BOTH modes. Forget leaves the FILES; it does not leave BOS's record of
  // where they push to. An orphaned config is listed by no page — its filesystem
  // is gone — but `getUniqueRemoteName` still counts it, so re-adding the same
  // repository named its real remote `origin-2` and left "origin" pointing at
  // the dead one.
  const { removeRemoteConfigsForFilesystem } = await import("@/lib/gitops/remote-config");
  const removed = removeRemoteConfigsForFilesystem(id);

  if (mode === "delete") {
    // Only what BOS created. A repository the user already had elsewhere is
    // reached by symlink and is not BOS's to delete.
    const managed = path.resolve(repositoriesDir());
    const repo = path.resolve(store.repoRoot);
    const rel = path.relative(managed, repo);
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
      await fs.rm(repo, { recursive: true, force: true });
    } else {
      logger().warn(COMPONENT, "forgot a repository BOS does not manage; files left in place", { id, repoRoot: repo });
    }
  }
  logger().info(COMPONENT, "repository deregistered", { id, mode, remoteConfigsRemoved: removed });
}
