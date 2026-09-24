// 048 T021 / FR-026 — a pack's runtime inside the USER'S repository.
//
// This is the one place BOS writes outside its own data directory on a pack's
// behalf, so the tests are mostly about restraint: it happens only when a pack
// declared it, only when asked, and never over a file the user owns.
//
//   npm run test:unit -- tests/specs/project-runtime.test.ts
import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { join } from "path";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import { execFileSync } from "child_process";
import { useTestDataDir } from "../services/_test-env";
import { specsRoot } from "../../src/os/specs-dir";
import { ensureStores } from "../../src/lib/specs/seed";
import { ensureBuiltinMethod } from "../../src/lib/specs/method/resolve";
import { getMethod, registerMethod, __resetMethodsForTest } from "../../src/lib/specs/method/registry";
import { projectRuntimeStatus, installProjectRuntime, describeProjectRuntime } from "../../src/lib/specs/method/project-runtime";
import type { MethodDescriptor } from "../../src/lib/specs/method/types";

function write(root: string, rel: string, body: string): void {
  const p = join(root, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, body);
}

/** A pack on disk that declares a runtime, plus user-specs bound to it. */
async function setup(dir: string, opts: { declare?: boolean } = {}): Promise<{ packRoot: string; repoRoot: string }> {
  ensureBuiltinMethod();
  await ensureStores();

  const packRoot = join(dir, "packs", "fakebmad");
  write(packRoot, "runtime/scripts/memlog.py", "print('memlog v1')\n");
  write(packRoot, "runtime/scripts/resolve_customization.py", "print('resolve v1')\n");
  write(packRoot, "runtime/config.toml", "[core]\nname = 'shipped'\n");
  write(packRoot, "runtime/custom/.keep", "");
  write(packRoot, "runtime/scripts/__pycache__/memlog.pyc", "binary\n");

  const base = getMethod("spec-kit")!;
  const descriptor: MethodDescriptor = {
    ...base,
    id: "fakebmad",
    label: "Fake BMAD",
    builtin: false,
    ...(opts.declare === false
      ? {}
      : { projectRuntime: { dir: "_bmad", from: "runtime", preserve: ["custom"] } }),
  };
  registerMethod(descriptor, packRoot);

  const userSpecs = join(specsRoot(), "user-specs");
  const manifest = JSON.parse(readFileSync(join(userSpecs, "spec-store.json"), "utf8")) as Record<string, unknown>;
  write(userSpecs, "spec-store.json", JSON.stringify({ ...manifest, workflow: "fakebmad" }, null, 2));
  execFileSync("git", ["add", "-A"], { cwd: userSpecs });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "bind"], { cwd: userSpecs });

  return { packRoot, repoRoot: userSpecs };
}

async function withSetup(name: string, body: (ctx: { packRoot: string; repoRoot: string; dir: string }) => Promise<void>, opts = {}): Promise<void> {
  // eslint-disable-next-line react-hooks/rules-of-hooks -- a test fixture, not a React hook
  const { dir, cleanup } = useTestDataDir(name);
  try {
    const ctx = await setup(dir, opts);
    await body({ ...ctx, dir });
  } finally {
    __resetMethodsForTest();
    cleanup();
  }
}

test("a declared runtime is REPORTED as missing, and nothing is written", async () => {
  // The central restraint: resolving a store's method must not install anything.
  await withSetup("pr-report", async ({ repoRoot }) => {
    const st = await projectRuntimeStatus("user-specs");
    expect(st.missing).toBe(true);
    expect(st.projectRoot, "{project-root} is the store's REPOSITORY (050)").toBe(repoRoot);
    expect(existsSync(join(repoRoot, "_bmad")), "reading did not write").toBe(false);

    const text = describeProjectRuntime(st);
    expect(text, "names the repository, which is the fact to agree to").toContain(repoRoot);
    expect(text).toMatch(/YOUR repository/);
    expect(text, "and says what breaks until it is done").toContain("will fail");
  });
});

test("installing writes the pack's runtime into the repository", async () => {
  await withSetup("pr-install", async ({ repoRoot }) => {
    const r = await installProjectRuntime("user-specs");
    expect(r.blocked).toBeUndefined();
    expect(r.target).toBe(join(repoRoot, "_bmad"));
    expect(r.written.sort()).toEqual([
      "config.toml",
      "custom/.keep",
      "scripts/memlog.py",
      "scripts/resolve_customization.py",
    ]);
    expect(readFileSync(join(repoRoot, "_bmad/scripts/memlog.py"), "utf8")).toBe("print('memlog v1')\n");
    expect(existsSync(join(repoRoot, "_bmad/scripts/__pycache__")), "build output is not runtime").toBe(false);

    expect((await projectRuntimeStatus("user-specs")).missing).toBe(false);
  });
});

test("a PRESERVED path is written once and never again — team overrides survive", async () => {
  // The upgrade failure this guards: BMAD's _bmad/custom/<skill>.toml holds
  // committed team customisations, and a refresh that rewrote them would revert
  // work silently.
  await withSetup("pr-preserve", async ({ repoRoot, packRoot }) => {
    await installProjectRuntime("user-specs");
    write(repoRoot, "_bmad/custom/bmad-prd.toml", "[workflow]\nmine = true\n");

    // The pack ships a new version of everything, including custom/.
    write(packRoot, "runtime/scripts/memlog.py", "print('memlog v2')\n");
    write(packRoot, "runtime/custom/.keep", "CHANGED UPSTREAM\n");

    const r = await installProjectRuntime("user-specs");
    expect(readFileSync(join(repoRoot, "_bmad/scripts/memlog.py"), "utf8"), "the pack's own files refresh").toBe("print('memlog v2')\n");
    expect(readFileSync(join(repoRoot, "_bmad/custom/bmad-prd.toml"), "utf8"), "the user's file is untouched").toContain("mine = true");
    expect(readFileSync(join(repoRoot, "_bmad/custom/.keep"), "utf8"), "and so is everything else under custom/").toBe("");
    // The whole DIRECTORY is preserved as one unit, not file by file — so a file
    // the user added under it is safe without the pack having to know about it.
    expect(r.preserved).toEqual(["custom"]);
  });
});

test("a pack that declares no runtime gets nothing, and BOS touches no repository", async () => {
  await withSetup("pr-none", async ({ repoRoot }) => {
    const st = await projectRuntimeStatus("user-specs");
    expect(st.spec).toBeUndefined();
    expect(st.missing).toBe(false);

    const r = await installProjectRuntime("user-specs");
    expect(r.blocked).toContain("declares no project runtime");
    expect(existsSync(join(repoRoot, "_bmad"))).toBe(false);
  }, { declare: false });
});

test("a declared source the pack does not ship is reported, not an empty success", async () => {
  // Same class as a declared-but-absent templates directory: named, never
  // silently treated as "nothing to copy".
  await withSetup("pr-missing-source", async ({ repoRoot }) => {
    const base = getMethod("fakebmad")!;
    registerMethod({ ...base, projectRuntime: { dir: "_bmad", from: "no-such-dir" } }, join(repoRoot, "..", "nope"));
    const r = await installProjectRuntime("user-specs");
    expect(r.blocked).toContain("does not ship");
    expect(r.written).toEqual([]);
  });
});

test("re-installing refreshes the pack's files and hands the rest to the user", async () => {
  // Idempotent in the sense that matters — the DISK converges — but the report
  // legitimately differs: on the first run `custom/` did not exist so it was
  // written; on the second it is the user's and is preserved. Asserting the two
  // reports are identical would be asserting that BOS keeps overwriting it.
  await withSetup("pr-idempotent", async ({ repoRoot }) => {
    const first = await installProjectRuntime("user-specs");
    expect(first.written).toContain("custom/.keep");
    expect(first.preserved).toEqual([]);

    const second = await installProjectRuntime("user-specs");
    expect(second.blocked).toBeUndefined();
    expect(second.written.sort(), "the pack's own files are rewritten every time").toEqual([
      "config.toml",
      "scripts/memlog.py",
      "scripts/resolve_customization.py",
    ]);
    expect(second.preserved, "and custom/ has become the user's").toEqual(["custom"]);
    expect(existsSync(join(repoRoot, "_bmad/custom/.keep")), "still on disk either way").toBe(true);
  });
});
