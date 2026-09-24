// The BEHAVIOURAL CONTRACT of the six VFS CRUD tools — file_list, file_read,
// file_write, file_mkdir, file_delete, file_rename — expressed once, so the two
// implementations that must satisfy it can be driven through the SAME cases:
//
//   tests/assistant/file-tools-frontend-path.test.ts  → the browser path
//       (fsClient.scoped(conversationId) → /api/fs → withFeatureScope → vfs.*)
//   tests/assistant/file-tools-server.test.ts         → the server tools
//       (fileTools() → withFeatureScope → vfs.*)
//
// WHY A SHARED SUITE RATHER THAN TWO HAND-WRITTEN ONES. The point of this work
// is a claim of EQUIVALENCE: moving these tools server-side must not change
// where or how they touch the user's VFS. Two independently-written suites can
// both pass while testing different things — which is exactly how a migration
// loses a branch-coupling rule or a path-escape guard without any test going
// red. One suite, two drivers, makes the equivalence the thing under test.
//
// WHAT A DRIVER MUST NOT DO. A driver adapts calling conventions only: it maps
// (op, args, conversationId) onto its implementation and normalises the outcome
// into `DriverResult`. It must never reimplement a rule the tool is responsible
// for — no path normalisation, no scope resolution, no error classification. A
// driver that decided any of those would let a scenario pass against an
// implementation that does not actually enforce it (AGENTS.md §1.1: "a fixture
// that stands in for a missing step cannot detect that the step is missing").
//
//   npm run test:unit -- tests/assistant/file-tools-frontend-path.test.ts
//   npm run test:unit -- tests/assistant/file-tools-server.test.ts

import "../../services/_stub-server-only";
import { expect } from "@playwright/test";
import { join } from "path";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import { useTestDataDir } from "../../services/_test-env";
import * as vfs from "../../../src/os/vfs";
import { SpecFS } from "../../../src/os/fs/spec-fs";
import { ensureRepo } from "../../../src/lib/gitfs/store";
import { encodeBranchDir } from "../../../src/lib/specs/feature-id";
import * as conversations from "../../../src/lib/agent/conversations-server";

// ---------------------------------------------------------------------------
// Driver contract
// ---------------------------------------------------------------------------

/** Normalised outcome of one tool call.
 *
 *  Both implementations converge on the same two-state shape, by different
 *  routes: the browser handler's `jsonOrThrow` rejects on a 400 and the client
 *  tool kernel turns the rejection into an in-band `Error: <tool>: <message>`
 *  string; `serverTool` catches and formats the identical string itself. The
 *  driver unwraps whichever happened, so scenarios assert on the MESSAGE the
 *  model would see rather than on either transport's framing. */
export type DriverResult = { ok: true; text: string } | { ok: false; message: string };

/** Every call carries the conversation id the way the real caller does — the
 *  `x-bos-conversation` header for the browser path, `ctx.conversationId` for
 *  the server path. That is the ONLY channel an agent tool has for feature
 *  scope; the explicit `branch` override exists solely for apps and is covered
 *  separately in the frontend-path file, not here. */
export interface FileToolDriver {
  /** Label used in test titles, e.g. "frontend-path" / "server". */
  readonly label: string;
  list(conversationId: string, path?: string): Promise<DriverResult>;
  read(conversationId: string, path: string): Promise<DriverResult>;
  write(conversationId: string, path: string, content: string): Promise<DriverResult>;
  mkdir(conversationId: string, path: string): Promise<DriverResult>;
  remove(conversationId: string, path: string): Promise<DriverResult>;
  rename(conversationId: string, from: string, to: string): Promise<DriverResult>;
}

/** Assert success and return the model-visible text. Failing here prints the
 *  error the implementation actually produced, which is the thing you need. */
export function expectOk(result: DriverResult, what: string): string {
  if (!result.ok) throw new Error(`${what}: expected success, got error: ${result.message}`);
  return result.text;
}

/** Assert failure and return the message, so a scenario can match its cause. */
export function expectErr(result: DriverResult, what: string): string {
  if (result.ok) throw new Error(`${what}: expected an error, got success: ${result.text}`);
  return result.message;
}

/** The `file_list` payload shape both implementations must produce: a JSON
 *  array of {name, path, type, size} — deliberately WITHOUT `modified`, which
 *  `VfsEntry` carries but the tool strips. That omission is contract, not
 *  accident: a per-call-varying mtime in the transcript makes every listing a
 *  cache-buster and a diff-noise source in conversation replay. */
export interface ListedEntry {
  name: string;
  path: string;
  type: "file" | "dir";
  size: number;
}

export function parseListing(text: string): ListedEntry[] {
  return JSON.parse(text) as ListedEntry[];
}

// ---------------------------------------------------------------------------
// Scenario environment
// ---------------------------------------------------------------------------

export const CONVERSATION = "conv-file-tools";
export const BRANCH = "bos/testfixture-file-tools-contract";

export interface ScenarioEnv {
  /** The sandboxed BOS_DATA_DIR for this scenario. */
  readonly dataDir: string;
  /** Host path of the plain (unmounted) VFS root, `<dataDir>/vfs`. */
  readonly vfsRoot: string;
  /** Host path of the user spec store's base checkout. */
  readonly userStoreRoot: string;
  /** Host path of the read-only system spec store's base checkout. */
  readonly systemStoreRoot: string;
  /** Host path of the self-provisioned worktree SpecFS writes to for BRANCH. */
  readonly userStoreBranchRoot: string;
  /** Make `getActiveBranch()` resolve (or stop resolving) a branch for
   *  CONVERSATION. Scenarios call this to move between "a feature is active"
   *  and "none is" WITHOUT touching the driver — proving the tool itself reads
   *  the scope rather than the test handing it one. */
  setActiveBranch(branch: string | undefined): void;
}

/** Stub the single accessor the feature-scope layer reads.
 *
 *  Seeding a real conversation would write under /Documents/Chats, which
 *  os/vfs.ts deliberately routes through the CANONICAL data root — the leak
 *  documented in tests/services/_test-env.ts. Replacing this one function keeps
 *  the whole conversation-store mechanism out of these tests while leaving the
 *  path under test (withFeatureScope → getActiveBranch → SpecFS) fully intact. */
function stubActiveBranch(): { set: (b: string | undefined) => void; restore: () => void } {
  const mod = conversations as unknown as Record<string, unknown>;
  const real = mod.getConversationActiveFeatureBranch;
  let current: string | undefined;
  mod.getConversationActiveFeatureBranch = async (id: string) => (id === CONVERSATION ? current : undefined);
  return {
    set: (b) => {
      current = b;
    },
    restore: () => {
      mod.getConversationActiveFeatureBranch = real;
    },
  };
}

/**
 * Build one scenario's world: a sandboxed data dir, a seeded plain VFS, and
 * REAL SpecFS backends mounted at the real `/Specs/...` prefixes.
 *
 * Two ordering rules are load-bearing here.
 *
 * 1. `vfs.list("/")` runs FIRST. The first VFS call in a worker triggers
 *    `ensureVfs()` → `ensureSpecMount()` → `ensureSystemMounts()`, which
 *    registers the production mounts and latches itself. Registering ours
 *    before that would simply be overwritten by it on the next call, and the
 *    scenario would silently run against the production spec root. Letting it
 *    fire first, then re-registering (registerMount is last-wins), pins the
 *    mounts to this scenario's dirs deterministically.
 *
 * 2. Cleanup unregisters both prefixes. Playwright reuses a worker across test
 *    FILES, so a mount left pointing at a deleted temp dir would surface as an
 *    inexplicable failure in an unrelated file that runs next.
 */
export async function setupScenario(label: string): Promise<ScenarioEnv & { cleanup: () => void }> {
  // eslint-disable-next-line react-hooks/rules-of-hooks -- a test fixture, not a hook
  const { dir, cleanup: cleanupDir } = useTestDataDir(`file-tools-${label}`);
  const branchStub = stubActiveBranch();

  // (1) Let the production mount registration fire and latch before ours.
  await vfs.list("/");

  const specsRoot = join(dir, "specs");
  const userStoreRoot = join(specsRoot, "user-specs");
  const systemStoreRoot = join(specsRoot, "bos-system-specs");
  const worktrees = join(specsRoot, ".worktrees");
  await ensureRepo(userStoreRoot);
  await ensureRepo(systemStoreRoot);

  // A file that exists on the BASE checkout of each store, so a read with no
  // active branch has something real to resolve to.
  writeFileSync(join(userStoreRoot, "base-note.md"), "on base\n");
  writeFileSync(join(systemStoreRoot, "shipped.md"), "shipped with BOS\n");

  vfs.registerMount("/Specs/user-specs", new SpecFS(userStoreRoot, "user-specs", worktrees, true));
  vfs.registerMount("/Specs/bos-system-specs", new SpecFS(systemStoreRoot, "bos-system-specs", worktrees, false));

  return {
    dataDir: dir,
    vfsRoot: join(dir, "vfs"),
    userStoreRoot,
    systemStoreRoot,
    userStoreBranchRoot: join(worktrees, encodeBranchDir(BRANCH)),
    setActiveBranch: branchStub.set,
    cleanup: () => {
      vfs.unregisterMount("/Specs/user-specs");
      vfs.unregisterMount("/Specs/bos-system-specs");
      branchStub.restore();
      cleanupDir();
    },
  };
}

// ---------------------------------------------------------------------------
// The scenarios
// ---------------------------------------------------------------------------

export interface Scenario {
  name: string;
  run: (d: FileToolDriver, env: ScenarioEnv) => Promise<void>;
}

/** Host path of a plain VFS path, for asserting on what actually hit disk
 *  rather than on what the tool said it did. */
function onDisk(env: ScenarioEnv, vfsPath: string): string {
  return join(env.vfsRoot, vfsPath.replace(/^\/+/, ""));
}

export const FILE_TOOL_SCENARIOS: Scenario[] = [
  // ---- plain, unmounted VFS: the user's own sandbox -----------------------
  {
    name: "write then read round-trips through the user's sandbox",
    run: async (d, env) => {
      const path = "/Documents/round-trip.txt";
      const said = expectOk(await d.write(CONVERSATION, path, "hello vfs"), "write");
      expect(said).toBe(`Wrote ${path}.`);
      // The write is real, and it landed under this data dir's vfs root — not
      // somewhere else that a later read would also happen to find.
      expect(readFileSync(onDisk(env, path), "utf8")).toBe("hello vfs");
      expect(expectOk(await d.read(CONVERSATION, path), "read")).toBe("hello vfs");
    },
  },
  {
    name: "write creates missing parent directories",
    run: async (d, env) => {
      const path = "/Documents/deep/nested/new.txt";
      expectOk(await d.write(CONVERSATION, path, "x"), "write");
      expect(readFileSync(onDisk(env, path), "utf8")).toBe("x");
    },
  },
  {
    name: "write overwrites an existing file rather than appending",
    run: async (d) => {
      const path = "/Documents/overwrite.txt";
      expectOk(await d.write(CONVERSATION, path, "first"), "write 1");
      expectOk(await d.write(CONVERSATION, path, "second"), "write 2");
      expect(expectOk(await d.read(CONVERSATION, path), "read")).toBe("second");
    },
  },
  {
    name: "list returns {name,path,type,size} with full VFS paths, dirs first",
    run: async (d) => {
      expectOk(await d.write(CONVERSATION, "/Documents/listing/b.txt", "bb"), "write file");
      expectOk(await d.mkdir(CONVERSATION, "/Documents/listing/a-dir"), "mkdir");

      const entries = parseListing(expectOk(await d.list(CONVERSATION, "/Documents/listing"), "list"));
      expect(entries.map((e) => e.name)).toEqual(["a-dir", "b.txt"]); // dirs sort first
      const file = entries.find((e) => e.name === "b.txt")!;
      expect(file.path).toBe("/Documents/listing/b.txt"); // full VFS path, not relative
      expect(file.type).toBe("file");
      expect(file.size).toBe(2);
      expect(entries.find((e) => e.name === "a-dir")!.type).toBe("dir");
      // `modified` is deliberately stripped — see ListedEntry.
      for (const e of entries) expect(Object.keys(e).sort()).toEqual(["name", "path", "size", "type"]);
    },
  },
  {
    name: "list with no path argument lists the VFS root",
    run: async (d) => {
      // Deliberately does NOT assert on the seeded Documents/Pictures/Desktop
      // tree. `ensureVfs()`'s `seeded` flag is a module-level latch, so in a
      // worker that already ran another VFS test those directories are never
      // created for THIS data dir — the assertion would then pass or fail
      // purely on test file ordering. A marker this scenario creates itself is
      // ordering-independent and tests the same thing.
      expectOk(await d.mkdir(CONVERSATION, "/root-listing-marker"), "mkdir marker");

      const entries = parseListing(expectOk(await d.list(CONVERSATION), "list"));
      const marker = entries.find((e) => e.name === "root-listing-marker");
      expect(marker, "a no-path list must default to the VFS root").toBeDefined();
      expect(marker!.type).toBe("dir");
      // Every entry is a direct child of "/", so an implementation that
      // defaulted to some other directory cannot pass.
      for (const e of entries) expect(e.path).toBe(`/${e.name}`);
    },
  },
  {
    name: "mkdir creates intermediate directories and is idempotent",
    run: async (d, env) => {
      expectOk(await d.mkdir(CONVERSATION, "/Documents/x/y/z"), "mkdir");
      expect(existsSync(onDisk(env, "/Documents/x/y/z"))).toBe(true);
      // A second call must not error — agents re-issue mkdir freely.
      expectOk(await d.mkdir(CONVERSATION, "/Documents/x/y/z"), "mkdir again");
    },
  },
  {
    name: "delete removes a file",
    run: async (d, env) => {
      const path = "/Documents/doomed.txt";
      expectOk(await d.write(CONVERSATION, path, "bye"), "write");
      expect(expectOk(await d.remove(CONVERSATION, path), "delete")).toBe(`Deleted ${path}.`);
      expect(existsSync(onDisk(env, path))).toBe(false);
    },
  },
  {
    name: "delete removes a non-empty folder recursively",
    run: async (d, env) => {
      expectOk(await d.write(CONVERSATION, "/Documents/tree/a/b.txt", "b"), "write");
      expectOk(await d.remove(CONVERSATION, "/Documents/tree"), "delete");
      expect(existsSync(onDisk(env, "/Documents/tree"))).toBe(false);
    },
  },
  {
    name: "delete refuses to remove the VFS root",
    run: async (d, env) => {
      const msg = expectErr(await d.remove(CONVERSATION, "/"), "delete root");
      expect(msg).toContain("Refusing to remove the VFS root");
      // The guard held: the seeded tree is still there.
      expect(existsSync(onDisk(env, "/Documents"))).toBe(true);
    },
  },
  {
    name: "rename moves a file and creates the target's parent directory",
    run: async (d, env) => {
      expectOk(await d.write(CONVERSATION, "/Documents/from.txt", "payload"), "write");
      const said = expectOk(await d.rename(CONVERSATION, "/Documents/from.txt", "/Documents/moved/to.txt"), "rename");
      expect(said).toBe("Renamed /Documents/from.txt to /Documents/moved/to.txt.");
      expect(existsSync(onDisk(env, "/Documents/from.txt"))).toBe(false);
      expect(readFileSync(onDisk(env, "/Documents/moved/to.txt"), "utf8")).toBe("payload");
    },
  },
  {
    name: "reading a missing file reports the failure instead of an empty string",
    run: async (d) => {
      // The dangerous failure mode is a swallowed ENOENT returning "" — the
      // agent then believes the file exists and is blank (AGENTS.md §1.2).
      const msg = expectErr(await d.read(CONVERSATION, "/Documents/nope.txt"), "read missing");
      expect(msg).toMatch(/ENOENT|no such file/i);
    },
  },
  {
    name: "listing a missing directory reports the failure instead of an empty array",
    run: async (d) => {
      const msg = expectErr(await d.list(CONVERSATION, "/Documents/not-a-dir"), "list missing");
      expect(msg).toMatch(/ENOENT|no such file/i);
    },
  },

  // ---- the path jail ------------------------------------------------------
  {
    name: "a traversal path cannot escape the VFS root on read",
    run: async (d) => {
      // Normalisation happens INSIDE the VFS, so "/Documents/../../etc/passwd"
      // normalises to "/etc/passwd" and stays jailed rather than escaping.
      const msg = expectErr(await d.read(CONVERSATION, "/../../../../etc/passwd"), "escape read");
      expect(msg).toMatch(/ENOENT|no such file|escapes the VFS root/i);
    },
  },
  {
    name: "a traversal path cannot escape the VFS root on write",
    run: async (d, env) => {
      const escaped = join(env.dataDir, "escaped.txt");
      const result = await d.write(CONVERSATION, "/Documents/../../../escaped.txt", "pwned");
      // Either outcome is acceptable (normalise-and-jail, or refuse) — what is
      // NOT acceptable is a file appearing outside the VFS root.
      if (result.ok) expect(readFileSync(onDisk(env, "/escaped.txt"), "utf8")).toBe("pwned");
      expect(existsSync(escaped)).toBe(false);
    },
  },

  // ---- branch-coupled mount: /Specs/user-specs ----------------------------
  {
    name: "writing to /Specs with an active feature branch lands on that branch's worktree",
    run: async (d, env) => {
      env.setActiveBranch(BRANCH);
      const path = "/Specs/user-specs/my-project/001-thing/spec.md";
      expectOk(await d.write(CONVERSATION, path, "# Thing\n"), "write on branch");

      // The write went to the branch worktree, NOT the base checkout. This is
      // the assertion the whole migration turns on: it can only pass if the
      // tool bound the feature scope before calling the VFS.
      expect(readFileSync(join(env.userStoreBranchRoot, "my-project/001-thing/spec.md"), "utf8")).toBe("# Thing\n");
      expect(existsSync(join(env.userStoreRoot, "my-project/001-thing/spec.md"))).toBe(false);
    },
  },
  {
    name: "writing to /Specs with NO active feature branch is refused, not silently redirected",
    run: async (d, env) => {
      env.setActiveBranch(undefined);
      const msg = expectErr(
        await d.write(CONVERSATION, "/Specs/user-specs/my-project/001-thing/spec.md", "# Thing\n"),
        "write with no branch",
      );
      expect(msg).toContain("No active feature context");
      // Nothing leaked onto the base checkout.
      expect(existsSync(join(env.userStoreRoot, "my-project"))).toBe(false);
    },
  },
  {
    name: "reading /Specs with no active branch resolves the base checkout",
    run: async (d, env) => {
      env.setActiveBranch(undefined);
      expect(expectOk(await d.read(CONVERSATION, "/Specs/user-specs/base-note.md"), "read base")).toBe("on base\n");
    },
  },
  {
    name: "reading /Specs with an active branch sees that branch's pending writes",
    run: async (d, env) => {
      env.setActiveBranch(BRANCH);
      const path = "/Specs/user-specs/pending.md";
      expectOk(await d.write(CONVERSATION, path, "only on the branch\n"), "write");
      expect(expectOk(await d.read(CONVERSATION, path), "read on branch")).toBe("only on the branch\n");

      // …and the same read with no branch active falls back to base, where the
      // file does not exist. Same tool, same path, different scope.
      env.setActiveBranch(undefined);
      expectErr(await d.read(CONVERSATION, path), "read off branch");
    },
  },
  {
    name: "mkdir, delete and rename under /Specs all honour the branch gate",
    run: async (d, env) => {
      env.setActiveBranch(undefined);
      for (const [what, call] of [
        ["mkdir", () => d.mkdir(CONVERSATION, "/Specs/user-specs/gated")],
        ["delete", () => d.remove(CONVERSATION, "/Specs/user-specs/base-note.md")],
        ["rename", () => d.rename(CONVERSATION, "/Specs/user-specs/base-note.md", "/Specs/user-specs/renamed.md")],
      ] as const) {
        expect(expectErr(await call(), `${what} with no branch`)).toContain("No active feature context");
      }
      // The base checkout is untouched by any of the three.
      expect(existsSync(join(env.userStoreRoot, "base-note.md"))).toBe(true);
      expect(existsSync(join(env.userStoreRoot, "gated"))).toBe(false);
    },
  },
  {
    name: "listing /Specs hides git internals and store manifests",
    run: async (d, env) => {
      env.setActiveBranch(undefined);
      writeFileSync(join(env.userStoreRoot, "spec-store.json"), "{}");
      mkdirSync(join(env.userStoreRoot, ".specify"), { recursive: true });

      const names = parseListing(expectOk(await d.list(CONVERSATION, "/Specs/user-specs"), "list")).map((e) => e.name);
      expect(names).toContain("base-note.md");
      expect(names).not.toContain("spec-store.json");
      expect(names).not.toContain(".specify");
      expect(names).not.toContain(".git");
    },
  },

  // ---- read-only mount: /Specs/bos-system-specs ---------------------------
  {
    name: "the system spec store is readable",
    run: async (d, env) => {
      env.setActiveBranch(BRANCH);
      expect(expectOk(await d.read(CONVERSATION, "/Specs/bos-system-specs/shipped.md"), "read")).toBe(
        "shipped with BOS\n",
      );
    },
  },
  {
    name: "the system spec store refuses writes EVEN WITH an active feature branch",
    run: async (d, env) => {
      // The gate is unconditional, not merely branch-dependent — a branch must
      // not be a way in. Every mutating op is checked, because it only takes
      // one unguarded op to make the store writable.
      env.setActiveBranch(BRANCH);
      for (const [what, call] of [
        ["write", () => d.write(CONVERSATION, "/Specs/bos-system-specs/shipped.md", "tampered")],
        ["mkdir", () => d.mkdir(CONVERSATION, "/Specs/bos-system-specs/new-dir")],
        ["delete", () => d.remove(CONVERSATION, "/Specs/bos-system-specs/shipped.md")],
        ["rename", () => d.rename(CONVERSATION, "/Specs/bos-system-specs/shipped.md", "/Specs/bos-system-specs/x.md")],
      ] as const) {
        expect(expectErr(await call(), `${what} on read-only store`)).toContain("read-only");
      }
      expect(readFileSync(join(env.systemStoreRoot, "shipped.md"), "utf8")).toBe("shipped with BOS\n");
    },
  },

  // ---- mount boundaries ---------------------------------------------------
  {
    name: "rename across a mount boundary is refused rather than silently corrupting",
    run: async (d, env) => {
      env.setActiveBranch(BRANCH);
      expectOk(await d.write(CONVERSATION, "/Documents/local.md", "local"), "write");

      // plain → mount
      expect(
        expectErr(await d.rename(CONVERSATION, "/Documents/local.md", "/Specs/user-specs/moved.md"), "out of plain"),
      ).toContain("Cannot rename across a VFS mount boundary");
      // mount → plain
      expect(
        expectErr(await d.rename(CONVERSATION, "/Specs/user-specs/base-note.md", "/Documents/stolen.md"), "out of mount"),
      ).toContain("Cannot rename across a VFS mount boundary");
      // mount → a DIFFERENT mount
      expect(
        expectErr(
          await d.rename(CONVERSATION, "/Specs/user-specs/base-note.md", "/Specs/bos-system-specs/x.md"),
          "across mounts",
        ),
      ).toContain("Cannot rename across a VFS mount boundary");

      expect(readFileSync(onDisk(env, "/Documents/local.md"), "utf8")).toBe("local");
    },
  },

  // ---- feature scope is per-conversation ----------------------------------
  {
    name: "feature scope is read from the CALLING conversation, not a process global",
    run: async (d, env) => {
      env.setActiveBranch(BRANCH); // only for CONVERSATION
      const path = "/Specs/user-specs/scoped.md";
      expectOk(await d.write(CONVERSATION, path, "scoped\n"), "write as scoped conversation");

      // A different conversation has no active branch, so the same write is
      // refused. A tool that bound a global (or no) scope would pass the call
      // above and then wrongly succeed here too.
      const other = expectErr(await d.write("conv-other", path, "leaked\n"), "write as other conversation");
      expect(other).toContain("No active feature context");
    },
  },
];
