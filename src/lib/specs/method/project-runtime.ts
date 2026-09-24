// 048 T021 / FR-026 — what a pack installs into the user's own repository.
//
// BMAD does not work without it: 75 of its skill files shell out to
// `{project-root}/_bmad/scripts/*.py`, and `_bmad/custom/<skill>.toml` is where a
// team's committed customisations live. Neither can live in BOS's `data/` —
// `{project-root}` is where `npx bmad-method install` puts them, so BMAD's own
// CLI keeps working on the same checkout, and an override is committed with the
// code it describes.
//
// THIS MODULE WRITES INTO SOMEONE ELSE'S REPOSITORY. Three rules follow, and
// they are the whole reason it is a module rather than four lines somewhere:
//
//   1. ONLY WHEN DECLARED. A pack asks for it by name (`projectRuntime`) or BOS
//      touches no repository on its behalf. There is no inference and no
//      convention — a pack that needs nothing gets nothing.
//   2. NEVER AS A SIDE EFFECT. Opening a store, listing specs or resolving a
//      method must not install anything. `status()` reports; `install()` writes;
//      and the only callers of `install()` are an explicit user or agent action.
//   3. NEVER OVER THE USER'S OWN FILES. `preserve` paths are written once and
//      then left alone forever, because they hold committed team customisations
//      and an upgrade that reverts them is the silent-loss failure this whole
//      feature series exists to stop.

import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { logger } from "@/lib/logging/server-logger";
import { listStores } from "@/lib/specs/stores";
import { methodForStore } from "@/lib/specs/pipeline";
import { methodPackRoot } from "./registry";
import type { MethodDescriptor, ProjectRuntimeSpec } from "./types";

const COMPONENT = "specs.method.project-runtime";

export interface ProjectRuntimeStatus {
  storeId: string;
  /** The method that asked for it. */
  methodId: string;
  /** Absolute path of the repository the store lives in — `{project-root}`. */
  projectRoot: string;
  /** What the pack declared, or undefined when it declared nothing. */
  spec?: ProjectRuntimeSpec;
  /** Absolute path of the directory the pack wants, when it wants one. */
  target?: string;
  /** True when the pack needs a runtime and it is not there. A bound store in
   *  this state is REPORTED rather than silently repaired — the repair writes to
   *  the user's repo and must be their action. */
  missing: boolean;
  /** Why no runtime is possible, when that is the answer. Never silence: a store
   *  outside a repository genuinely cannot host one, and saying so beats leaving
   *  someone to wonder why a skill keeps failing. */
  blocked?: string;
}

/** `{project-root}` for a store: the repository it lives in (050).
 *
 *  Branch-aware, because the store most likely to need a runtime installed is
 *  an app just created under a pack that declares one — and such an app exists
 *  only in that branch's clone. Resolved from base alone it answered "there is
 *  no spec store", which reads as a typo rather than as a missing branch. It
 *  also gets the RIGHT repository: an item found on the branch carries that
 *  clone's user-apps as its repoRoot, so the runtime is installed where the
 *  work is and promotes with it. */
async function projectRootFor(storeId: string, branch?: string): Promise<{ root?: string; why?: string }> {
  const store = (await listStores(branch)).find((s) => s.id === storeId);
  if (!store) return { why: `There is no spec store "${storeId}".` };
  if (!store.repoRoot) {
    return { why: `"${storeId}" is not inside a git repository, so there is no project root to install into.` };
  }
  return { root: store.repoRoot };
}

/** Does this store's method need a project runtime, and is it there? */
export async function projectRuntimeStatus(storeId: string, branch?: string): Promise<ProjectRuntimeStatus> {
  const descriptor: MethodDescriptor = await methodForStore(storeId, undefined, branch);
  const spec = descriptor.projectRuntime;
  const { root, why } = await projectRootFor(storeId, branch);

  if (!spec) {
    return { storeId, methodId: descriptor.id, projectRoot: root ?? "", missing: false };
  }
  if (!root) {
    return { storeId, methodId: descriptor.id, projectRoot: "", spec, missing: false, blocked: why };
  }

  const target = path.join(root, spec.dir);
  let present: boolean;
  try {
    present = (await fs.stat(target)).isDirectory();
  } catch (err) {
    // ENOENT is the ordinary "not installed yet". Anything else is a real
    // problem with the user's repository and must not read as "not installed",
    // which would have BOS offer to write into a path it cannot see.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    present = false;
  }
  return { storeId, methodId: descriptor.id, projectRoot: root, spec, target, missing: !present };
}

export interface ProjectRuntimeInstall {
  storeId: string;
  projectRoot: string;
  target: string;
  /** Relative paths written now. */
  written: string[];
  /** `preserve` paths that already existed and were therefore left alone. */
  preserved: string[];
  /** Set when nothing could be done, with the reason. */
  blocked?: string;
}

/** Copy `from` into `target`, skipping anything under a `preserve` path that is
 *  already there. Returns what it wrote, relative to `target`. */
async function copyRuntime(
  source: string,
  target: string,
  preserve: Set<string>,
  rel = "",
  out: { written: string[]; preserved: string[] } = { written: [], preserved: [] },
): Promise<{ written: string[]; preserved: string[] }> {
  // NOT `.catch(() => [])`: a source the pack declared and BOS cannot read is a
  // broken pack, and reporting it as "nothing to copy" would leave the user with
  // a runtime that silently does not work.
  const entries = await fs.readdir(path.join(source, rel), { withFileTypes: true });

  for (const e of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name === ".git" || e.name === "__pycache__") continue;
    const childRel = rel ? `${rel}/${e.name}` : e.name;

    // A preserved path is written ONCE. After that it is the user's, and an
    // upgrade that rewrote it would revert committed team customisations.
    const isPreserved = [...preserve].some((p) => childRel === p || childRel.startsWith(`${p}/`));
    if (isPreserved && (await exists(path.join(target, childRel)))) {
      out.preserved.push(childRel);
      continue;
    }

    if (e.isDirectory()) {
      await fs.mkdir(path.join(target, childRel), { recursive: true });
      await copyRuntime(source, target, preserve, childRel, out);
      continue;
    }
    if (!e.isFile()) continue;
    await fs.mkdir(path.dirname(path.join(target, childRel)), { recursive: true });
    await fs.copyFile(path.join(source, childRel), path.join(target, childRel));
    out.written.push(childRel);
  }
  return out;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/**
 * Install (or refresh) a store's project runtime.
 *
 * EXPLICIT ONLY. Nothing in the read paths calls this — not `listSpecifications`,
 * not `methodForStore`, not opening a store. BOS writing into a user's
 * repository is an action they take, and `projectRuntimeStatus` exists so a
 * surface can offer it rather than perform it.
 *
 * Idempotent: re-running refreshes the pack's own files and leaves every
 * `preserve` path exactly as the user left it.
 */
export async function installProjectRuntime(storeId: string, branch?: string): Promise<ProjectRuntimeInstall> {
  const status = await projectRuntimeStatus(storeId, branch);
  const base = { storeId, projectRoot: status.projectRoot, target: status.target ?? "", written: [], preserved: [] };

  if (status.blocked) return { ...base, blocked: status.blocked };
  if (!status.spec || !status.target) {
    return { ...base, blocked: `"${status.methodId}" declares no project runtime, so there is nothing to install.` };
  }

  const packRoot = methodPackRoot(status.methodId);
  if (!packRoot) {
    return { ...base, blocked: `"${status.methodId}" is registered without a pack root, so its runtime cannot be located.` };
  }
  const source = path.join(packRoot, status.spec.from);
  if (!(await exists(source))) {
    // The same class as a declared-but-absent templates dir: reported by name,
    // never as an empty success.
    return { ...base, blocked: `"${status.methodId}" declares a project runtime at "${status.spec.from}", which it does not ship.` };
  }

  await fs.mkdir(status.target, { recursive: true });
  const { written, preserved } = await copyRuntime(source, status.target, new Set(status.spec.preserve ?? []));

  logger().info(COMPONENT, "project runtime installed into the user's repository", {
    storeId,
    methodId: status.methodId,
    projectRoot: status.projectRoot,
    dir: status.spec.dir,
    written: written.length,
    preserved: preserved.length,
  });
  return { ...base, target: status.target, written, preserved };
}

/** One sentence for a person. Names the REPOSITORY, because that is the fact
 *  someone needs to agree to — not the store, which they were already looking
 *  at. */
export function describeProjectRuntime(s: ProjectRuntimeStatus): string {
  if (s.blocked) return s.blocked;
  if (!s.spec) return "";
  if (!s.missing) return `${s.methodId}'s ${s.spec.dir}/ is installed in ${s.projectRoot}.`;
  return (
    `${s.methodId} needs its ${s.spec.dir}/ directory inside ${s.projectRoot} — that is YOUR repository, and BOS has ` +
    `not written to it. Until it is installed, this method's skills that shell out to ${s.spec.dir}/ will fail.`
  );
}
