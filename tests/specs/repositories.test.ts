// 050 Phase 2 — registration (FR-001 … FR-009).
//   npm run test:unit -- tests/specs/repositories.test.ts
import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { join } from "path";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { execFileSync } from "child_process";
import { useTestDataDir } from "../services/_test-env";
import { specsRoot } from "../../src/os/specs-dir";
import { listStores } from "../../src/lib/specs/stores";
import { registerRepository, deregisterRepository, detectMethod, repositoriesDir } from "../../src/lib/specs/repositories";
import { registerMethod, __resetMethodsForTest } from "../../src/lib/specs/method/registry";
import { loadBuiltinDescriptor } from "../../src/lib/specs/method/builtin-pack";

const SPEC_KIT = loadBuiltinDescriptor();
function withMethods(): void {
  __resetMethodsForTest();
  registerMethod(SPEC_KIT);
  registerMethod({ ...SPEC_KIT, id: "openspec", label: "OpenSpec", storeRoot: "openspec" });
}

/** A bare origin to clone from — no network. */
function originRepo(dir: string): string {
  const src = join(dir, "origin-src");
  mkdirSync(src, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: src });
  writeFileSync(join(src, "README.md"), "# app\n");
  execFileSync("git", ["add", "-A"], { cwd: src });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"], { cwd: src });
  return src;
}

test("register by init: store root is the METHOD's folder, and the repo has a commit", async () => {
  const { cleanup } = useTestDataDir("repos-init");
  try {
    withMethods();
    const r = await registerRepository({ id: "invoice-parser", kind: "arbitrary", workflow: "openspec" });

    expect(r.storeRoot.endsWith("openspec"), "the method decides where specs live").toBe(true);
    expect(existsSync(join(r.storeRoot, "spec-store.json"))).toBe(true);
    // FR-005: an unborn HEAD surfaces later as unrelated git errors.
    const log = execFileSync("git", ["log", "--oneline"], { cwd: r.repoRoot, encoding: "utf8" });
    expect(log.trim().length, "a registered repo has a commit").toBeGreaterThan(0);

    const store = (await listStores()).find((s) => s.id === "invoice-parser");
    expect(store, "and it is discoverable through the ordinary scan").toBeDefined();
    expect(store!.repoRoot).toBe(r.repoRoot);
    expect(store!.kind).toBe("arbitrary");
    expect(store!.workflow).toBe("openspec:openspec");
  } finally {
    __resetMethodsForTest();
    cleanup();
  }
});

test("register by clone, and the SAME remote cannot be registered twice", async () => {
  const { dir, cleanup } = useTestDataDir("repos-clone");
  try {
    withMethods();
    const origin = originRepo(dir);
    await registerRepository({ id: "app-one", kind: "arbitrary", url: origin });

    // Two stores over one worktree diverge silently, each committing over the
    // other's branch state.
    let err: Error | undefined;
    await registerRepository({ id: "app-two", kind: "arbitrary", url: origin }).catch((e: Error) => { err = e; });
    expect(err, "the same remote twice is refused").toBeDefined();
    expect(err!.message).toContain("app-one");
  } finally {
    __resetMethodsForTest();
    cleanup();
  }
});

test("FR-006 — a failed registration leaves NOTHING behind", async () => {
  // Partial registration is worse than failure: it looks like success AND
  // blocks the retry.
  const { cleanup } = useTestDataDir("repos-rollback");
  try {
    withMethods();
    let err: Error | undefined;
    await registerRepository({ id: "broken", kind: "arbitrary", url: "/nonexistent/definitely-not-a-repo" })
      .catch((e: Error) => { err = e; });
    expect(err, "a bad URL fails").toBeDefined();

    expect(existsSync(join(repositoriesDir(), "broken")), "no clone residue").toBe(false);
    expect(existsSync(join(specsRoot(), "broken")), "no dangling symlink").toBe(false);
    // The retry must be possible, which is what the rollback is actually for.
    const r = await registerRepository({ id: "broken", kind: "arbitrary", workflow: "openspec" });
    expect(r.id).toBe("broken");
  } finally {
    __resetMethodsForTest();
    cleanup();
  }
});

test("FR-004 — an existing framework layout is DETECTED", async () => {
  const { dir, cleanup } = useTestDataDir("repos-detect");
  try {
    withMethods();
    const repo = join(dir, "already-openspec");
    mkdirSync(join(repo, "openspec", "changes"), { recursive: true });
    expect(await detectMethod(repo), "a repo already using OpenSpec").toBe("openspec");
    expect(await detectMethod(join(dir, "nothing-here")), "and nothing is claimed otherwise").toBeUndefined();
  } finally {
    __resetMethodsForTest();
    cleanup();
  }
});

test("FR-007 — forget leaves the files; delete removes them; BOS's own stores do neither", async () => {
  const { cleanup } = useTestDataDir("repos-remove");
  try {
    withMethods();
    const { ensureStores } = await import("../../src/lib/specs/seed");
    await ensureStores();

    const keep = await registerRepository({ id: "keep-me", kind: "arbitrary", workflow: "openspec" });
    await deregisterRepository("keep-me", "forget");
    expect(existsSync(join(specsRoot(), "keep-me")), "no longer tracked").toBe(false);
    expect(existsSync(keep.repoRoot), "FILES STAY — that is what forget means").toBe(true);

    const gone = await registerRepository({ id: "drop-me", kind: "arbitrary", workflow: "openspec" });
    await deregisterRepository("drop-me", "delete");
    expect(existsSync(gone.repoRoot), "delete removes the working copy").toBe(false);

    let err: Error | undefined;
    await deregisterRepository("user-specs", "forget").catch((e: Error) => { err = e; });
    expect(err, "BOS's own stores are not removable").toBeDefined();
  } finally {
    __resetMethodsForTest();
    cleanup();
  }
});

test("the manifest keeps keys this module never heard of", async () => {
  // BOS REWRITES spec-store.json, so a reader that reconstructs deletes the
  // rest from the user's repository on the next write.
  const { cleanup } = useTestDataDir("repos-manifest-roundtrip");
  try {
    withMethods();
    const r = await registerRepository({ id: "round-trip", kind: "arbitrary", workflow: "openspec" });
    const p = join(r.storeRoot, "spec-store.json");
    const m = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
    writeFileSync(p, JSON.stringify({ ...m, somethingCustom: "keep me" }, null, 2));

    const store = (await listStores()).find((s) => s.id === "round-trip") as unknown as Record<string, unknown>;
    expect(store.somethingCustom).toBe("keep me");
    expect(store.kind).toBe("arbitrary");
  } finally {
    __resetMethodsForTest();
    cleanup();
  }
});

// Cloning IS how origin gets registered, and the branch the clone lands on is
// the remote's own default. Recording it here is the one moment it is known for
// free — later, pull/push fall back to whatever is checked out locally, which
// stops being the default the first time BOS moves to a feature branch.
test("a clone registers its URL as origin, with the branch it actually landed on", async () => {
  const { dir, cleanup } = useTestDataDir("repos-origin");
  try {
    withMethods();
    const src = originRepo(dir);
    // Not `main`/`master`: a default named neither proves the branch is READ,
    // not assumed.
    execFileSync("git", ["branch", "-m", "trunk"], { cwd: src });

    await registerRepository({ id: "app", kind: "arbitrary", url: src });

    const { readRemoteConfigs } = await import("../../src/lib/gitops/remote-config");
    const mine = readRemoteConfigs().filter((c) => c.filesystem === "app");
    expect(mine.map((c) => c.name)).toEqual(["origin"]);
    expect(mine[0].url).toBe(src);
    expect(mine[0].defaultBranch, "the branch the clone checked out").toBe("trunk");
  } finally {
    __resetMethodsForTest();
    cleanup();
  }
});

// The live symptom: a repository added, removed and added again ended up with
// `origin` AND `origin-2` for one repo — and `origin`, the name everything
// resolves by, was the DEAD one from the first registration.
test("removing a repository takes its remote configs with it, so re-adding gets a clean origin", async () => {
  const { dir, cleanup } = useTestDataDir("repos-origin-residue");
  try {
    withMethods();
    const src = originRepo(dir);
    const { readRemoteConfigs } = await import("../../src/lib/gitops/remote-config");

    await registerRepository({ id: "app", kind: "arbitrary", url: src });
    await deregisterRepository("app", "delete");
    expect(readRemoteConfigs().filter((c) => c.filesystem === "app"), "forgotten means forgotten").toEqual([]);

    await registerRepository({ id: "app", kind: "arbitrary", url: src });
    const again = readRemoteConfigs().filter((c) => c.filesystem === "app");
    expect(again.map((c) => c.name), "not origin-2 beside an orphan").toEqual(["origin"]);
  } finally {
    __resetMethodsForTest();
    cleanup();
  }
});

// Another repository's `origin` is untouched. Remote names are unique only
// WITHIN a filesystem, so a cleanup that matched on name alone would take the
// wrong one — and credentials, which really are keyed by name alone, are
// deliberately left in place for exactly that reason.
test("removing one repository leaves another repository's origin alone", async () => {
  const { dir, cleanup } = useTestDataDir("repos-origin-isolation");
  try {
    withMethods();
    const a = originRepo(dir);
    const b = join(dir, "origin-src-b");
    mkdirSync(b, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: b });
    writeFileSync(join(b, "README.md"), "# b\n");
    execFileSync("git", ["add", "-A"], { cwd: b });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"], { cwd: b });

    await registerRepository({ id: "app-a", kind: "arbitrary", url: a });
    await registerRepository({ id: "app-b", kind: "arbitrary", url: b });
    await deregisterRepository("app-a", "forget");

    const { readRemoteConfigs } = await import("../../src/lib/gitops/remote-config");
    const all = readRemoteConfigs();
    expect(all.filter((c) => c.filesystem === "app-a")).toEqual([]);
    expect(all.filter((c) => c.filesystem === "app-b").map((c) => c.name)).toEqual(["origin"]);
  } finally {
    __resetMethodsForTest();
    cleanup();
  }
});
