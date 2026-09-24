// Unit tests for the Project layer (033-project-layer): a mandatory grouping
// folder inserted between a directory-scanned store and its features, with
// arbitrary plain sub-folders allowed below a project and per-project feature
// numbering. Covers the recursive walk in pipeline.ts, the migration that
// wraps pre-existing flat content into a default project, and — critically —
// that none of this disturbs the separate item-owned-store code path.
//   npm run test:unit -- tests/specs/project-layer.test.ts
import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { join } from "path";
import { mkdirSync, writeFileSync } from "fs";
import { execFileSync } from "child_process";
import { useTestDataDir } from "../services/_test-env";
import { specsRoot } from "../../src/os/specs-dir";
import { ensureStores } from "../../src/lib/specs/seed";
import { listProjects, createProject } from "../../src/lib/specs/projects";
import { specTree, listSpecifications, getSpecification, nextFeatureId } from "../../src/lib/specs/pipeline";
import * as specfs from "../../src/lib/dev/spec-fs";

// Creating a folder is a WRITE like any other now: the `project.json`
// exemption from the feature-branch rule is gone (spec-fs.ts prepareWrite),
// because it let a folder land on a user repository's default branch and
// then refused every attempt to put anything in it.
const BR = { branch: "bos/testfixture-project-layer" };

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** A project's content can only be written on a real feature branch (the
 *  same `bos/*` branch used for BOS's own source — there is no more
 *  per-Project session). No Supervisor runs in these unit tests, so
 *  dev/spec-fs.ts's `ctx.branch` worktree mount can't actually materialize —
 *  it falls straight through to the base checkout; any non-empty branch name
 *  here just satisfies `prepareWrite`'s gate. */
function branchCtx(projectId: string): { branch: string } {
  return { branch: `${projectId}/work` };
}

/** Lays out a store the way it looked BEFORE the Project layer existed: a
 *  git repo with a spec-store.json and a flat NNN-feature dir directly at the
 *  root, no project.json anywhere — exactly what a real deployment's
 *  pre-migration state would be. */
function layOutLegacyFlatStore(root: string, storeId: string, manifest: object, legacyFeatureId: string): string {
  const dir = join(root, storeId);
  mkdirSync(join(dir, legacyFeatureId), { recursive: true });
  writeFileSync(join(dir, "spec-store.json"), JSON.stringify(manifest, null, 2));
  writeFileSync(join(dir, legacyFeatureId, "spec.md"), `# Legacy feature ${legacyFeatureId}\n`);
  git(dir, ["init", "-q"]);
  git(dir, ["add", "-A"]);
  git(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "legacy layout"]);
  return dir;
}

test("migration wraps pre-existing flat content into one default project, idempotently", async () => {
  const { cleanup } = useTestDataDir("project-layer-migration");
  try {
    const root = specsRoot();
    mkdirSync(root, { recursive: true });
    layOutLegacyFlatStore(
      root,
      "user-specs",
      { label: "User specs", owner: "user", writable: true, requiresPromote: false },
      "002-legacy-feature",
    );

    await ensureStores();

    const projects = await listProjects("user-specs");
    expect(projects.map((p) => p.id)).toEqual(["user"]);
    expect(projects[0].label).toBe("User");

    const specs = await listSpecifications();
    const legacy = specs.find((s) => s.path === "user-specs/user/002-legacy-feature");
    expect(legacy).toBeTruthy();
    expect(legacy?.phases.find((p) => p.id === "specify")?.state).toBe("done");

    // Store-root siblings (spec-store.json) are untouched, not swept into the project.
    const untouched = specs.find((s) => s.path === "user-specs/spec-store.json");
    expect(untouched).toBeFalsy();

    // Re-running is a no-op: nothing left at top level to move, same result.
    await ensureStores();
    const projectsAgain = await listProjects("user-specs");
    expect(projectsAgain.map((p) => p.id)).toEqual(["user"]);
    const specsAgain = await listSpecifications();
    expect(specsAgain.filter((s) => s.store === "user-specs")).toHaveLength(1);
  } finally {
    cleanup();
  }
});

test("migration is a no-op once a store has been manually reorganized into differently-named Projects", async () => {
  // Regression: migrateToDefaultProject() originally decided "needs migration"
  // purely from "is there a top-level entry not literally named bos/user" —
  // so a REAL reorganization (renaming/splitting the default project into
  // e.g. "core-platform" + "assistant") looked identical to "never migrated"
  // and got silently re-wrapped into a fresh "user" dir on the next server
  // start, undoing the reorganization.
  const { cleanup } = useTestDataDir("project-layer-migration-reorg");
  try {
    const root = specsRoot();
    mkdirSync(root, { recursive: true });
    layOutLegacyFlatStore(
      root,
      "user-specs",
      { label: "User specs", owner: "user", writable: true, requiresPromote: false },
      "002-legacy-feature",
    );

    await ensureStores(); // first boot: wraps everything into the default "user" project
    expect((await listProjects("user-specs")).map((p) => p.id)).toEqual(["user"]);

    // Simulate a manual reorganization: rename "user" to two differently-named
    // projects, moving the one feature into "assistant".
    const storeDir = join(root, "user-specs");
    const { renameSync } = await import("fs");
    renameSync(join(storeDir, "user"), join(storeDir, "assistant"));
    mkdirSync(join(storeDir, "core-platform"), { recursive: true });
    writeFileSync(join(storeDir, "core-platform", "project.json"), JSON.stringify({ label: "Core Platform" }));

    await ensureStores(); // must NOT re-wrap "assistant"/"core-platform" into a new "user"
    const projects = await listProjects("user-specs");
    expect(projects.map((p) => p.id).sort()).toEqual(["assistant", "core-platform"]);

    const specs = await listSpecifications();
    expect(specs.find((s) => s.path === "user-specs/assistant/002-legacy-feature")).toBeTruthy();
    expect(specs.find((s) => s.path === "user-specs/user/002-legacy-feature")).toBeFalsy();
  } finally {
    cleanup();
  }
});

test("per-project feature numbering: the same NNN-slug can recur across two projects without collision", async () => {
  const { cleanup } = useTestDataDir("project-layer-numbering");
  try {
    await ensureStores(); // fresh, empty system/user stores — nothing to migrate

    await createProject("user-specs", "Alpha", undefined, BR);
    await createProject("user-specs", "Beta", undefined, BR);

    const alphaId = await nextFeatureId("Foo", "user-specs/alpha");
    expect(alphaId).toBe("user-specs/alpha/001-foo");
    await specfs.writeFile(`${alphaId}/spec.md`, "# Foo (alpha)\n", branchCtx("alpha"));

    const betaId = await nextFeatureId("Foo", "user-specs/beta");
    // Per-project scoping: beta's own scan sees no existing features, so it
    // also gets 001 — a store-wide scan would have bumped this to 002.
    expect(betaId).toBe("user-specs/beta/001-foo");
    await specfs.writeFile(`${betaId}/spec.md`, "# Foo (beta)\n", branchCtx("beta"));

    const specs = await listSpecifications();
    const paths = specs.filter((s) => s.store === "user-specs").map((s) => s.path).sort();
    expect(paths).toEqual(["user-specs/alpha/001-foo", "user-specs/beta/001-foo"]);

    const direct = await getSpecification("user-specs/beta/001-foo");
    expect(direct?.title).toBe("Foo (beta)");
  } finally {
    cleanup();
  }
});

test("recursive walk: a feature nested under an arbitrary plain sub-folder is discovered by spec.md presence, not depth", async () => {
  const { cleanup } = useTestDataDir("project-layer-nesting");
  try {
    await ensureStores();
    await createProject("user-specs", "Assistant App", undefined, BR);
    await specfs.writeFile(
      "user-specs/assistant-app/agent-loop/003-compaction/spec.md",
      "# Compaction\n",
      branchCtx("assistant-app"),
    );

    const specs = await listSpecifications();
    const nested = specs.find((s) => s.path === "user-specs/assistant-app/agent-loop/003-compaction");
    expect(nested).toBeTruthy();
    expect(nested?.title).toBe("Compaction");

    const tree = await specTree();
    const group = tree.find((g) => g.path === "user-specs");
    const project = group?.children?.find((c) => c.type === "project");
    expect(project?.label).toBe("Assistant App");
    const dir = project?.children?.find((c) => c.type === "dir");
    expect(dir?.name).toBe("agent-loop");
    const feature = dir?.children?.find((c) => c.type === "feature");
    expect(feature?.path).toBe("user-specs/assistant-app/agent-loop/003-compaction");
    expect(feature?.children?.map((c) => c.name)).toContain("spec.md");
  } finally {
    cleanup();
  }
});

test("project.json is hidden from directory listings, same as spec-store.json", async () => {
  const { cleanup } = useTestDataDir("project-layer-hidden-manifest");
  try {
    await ensureStores();
    await createProject("user-specs", "Alpha", undefined, BR);
    const entries = await specfs.listDir("user-specs/alpha");
    expect(entries.map((e) => e.name)).not.toContain("project.json");
  } finally {
    cleanup();
  }
});

test("converge phase reads discrepancies.md from user-specs too, not just the (now read-only) system store", async () => {
  // bos-system-specs is unconditionally read-only, so a NEW discrepancy can
  // never be recorded there again — derivePhases() must also check
  // user-specs/discrepancies.md, or converge tracking silently breaks for
  // every feature going forward.
  const { cleanup } = useTestDataDir("project-layer-discrepancies-user-store");
  try {
    await ensureStores();
    await createProject("user-specs", "Alpha", undefined, BR);
    await specfs.writeFile("user-specs/alpha/001-foo/spec.md", "# Foo\n", branchCtx("alpha"));
    await specfs.writeFile("user-specs/discrepancies.md", "- user-specs/alpha/001-foo: found a drift\n", branchCtx("alpha"));

    const specs = await listSpecifications();
    const spec = specs.find((s) => s.path === "user-specs/alpha/001-foo");
    expect(spec?.phases.find((p) => p.id === "converge")?.state).toBe("done");
  } finally {
    cleanup();
  }
});
