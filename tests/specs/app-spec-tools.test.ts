// Unit tests for the app_spec_* main-registry tools (src/lib/assistant/tools/
// server/specs.ts) — the tool surface that lets ANY chat context (not just
// Build Studio's own window) create/read/edit a marketplace item's spec.
// Exercises the handlers directly (bypassing the agent loop) end to end, and
// confirms the "item stores only" guard redirects a core-store path instead
// of silently doing the wrong thing.
//   npm run test:unit -- tests/specs/app-spec-tools.test.ts
import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { useTestDataDir } from "../services/_test-env";
import { listCatalog } from "../../src/lib/marketplace/client";
import { itemSpecTools } from "../../src/lib/assistant/tools/server/specs";
import type { ToolContext } from "../../src/lib/assistant/tools";

const CONVERSATION_ID = "test-conversation";

// NOTE: these tests deliberately do NOT seed a conversation's
// `activeFeatureBranch`. That field lives in /Documents/Chats, which os/vfs.ts
// treats as a CANONICAL subpath shared across data dirs and resolves once at
// module load — so writing there from a test both leaks into sibling tests and
// can be wiped by whichever test's useTestDataDir cleanup owns that root,
// making unrelated suites flaky. The branch-carrying path is covered at the
// spec-fs layer instead (item-stores.test.ts passes an explicit branch); what
// is asserted here is the tool-layer contract: with no active branch, every
// WRITE tool refuses and nothing is written, while reads still work.
function fakeCtx(): ToolContext {
  return {
    signal: new AbortController().signal,
    conversationId: CONVERSATION_ID,
    agentId: "test-agent",
    onEvent: () => {},
    elicit: async () => "",
    delegationDepth: 0,
    runId: "test-run",
  };
}

test("with no active feature branch, every app_spec_* WRITE tool refuses and writes nothing", async () => {
  const { dir, cleanup } = useTestDataDir("app-spec-tools-branch-gate");
  try {
    const tools = itemSpecTools();
    const ctx = fakeCtx();

    // Creation is gated too — it reaches user-apps via installItem(), not
    // spec-fs, so spec-fs's own prepareWrite gate never sees it. That was the
    // one hole left in the "every write needs a branch" rule.
    const created = await tools.app_spec_create.execute({ name: "Todo App", specBody: "# Todo App\n" }, ctx);
    expect(String(created)).toMatch(/active feature branch/i);
    expect(existsSync(join(dir, "user-apps", "items", "todo-app"))).toBe(false);

    // Lay an item down directly so the write/edit/patch tools have a real
    // target, and confirm each is refused for the same reason.
    const itemPath = join(dir, "user-apps", "items", "widget");
    mkdirSync(join(itemPath, "spec"), { recursive: true });
    writeFileSync(join(itemPath, "spec", "spec.md"), "# Widget\n\nv1.\n");
    mkdirSync(join(dir, "system"), { recursive: true });
    symlinkSync(itemPath, join(dir, "system", "widget"));
    await listCatalog();

    // Reads are NOT gated — only writes are.
    expect(String(await tools.app_spec_read.execute({ path: "item-widget/spec.md" }, ctx))).toContain("v1.");
    const listed = JSON.parse(String(await tools.app_spec_list.execute({ path: "item-widget" }, ctx)));
    expect(listed.map((e: { name: string }) => e.name)).toContain("spec.md");

    for (const [name, input] of [
      ["app_spec_write", { path: "item-widget/spec.md", content: "# Widget\n\nv2.\n" }],
      ["app_spec_edit", { path: "item-widget/spec.md", find: "v1.", replace: "v2." }],
      ["app_spec_patch", { path: "item-widget/spec.md", hunks: [{ find: "v1.", replace: "v2." }] }],
    ] as const) {
      const out = String(await tools[name].execute(input as Record<string, unknown>, ctx));
      expect(out, name).toMatch(/active feature branch/i);
    }

    // Nothing landed on disk through any of them.
    expect(readFileSync(join(itemPath, "spec", "spec.md"), "utf8")).toContain("v1.");
  } finally {
    cleanup();
  }
});

test("every app_spec_* tool refuses a core-store path and redirects to file_*", async () => {
  const { dir, cleanup } = useTestDataDir("app-spec-tools-guard");
  try {
    // A real bos-system-specs/user-specs store is seeded lazily by ensureStoresOnce();
    // seed it explicitly by triggering the same discovery path createItemSpec's
    // sibling tests rely on, then confirm the guard fires for it specifically.
    const { promises: fs } = await import("fs");
    const path = await import("path");
    const storeDir = path.join(dir, "specs", "user-specs");
    await fs.mkdir(storeDir, { recursive: true });
    await fs.writeFile(path.join(storeDir, "spec-store.json"), JSON.stringify({ label: "User specs", owner: "user", writable: true, requiresPromote: false }));
    const { execFileSync } = await import("child_process");
    execFileSync("git", ["init", "-q"], { cwd: storeDir });

    const tools = itemSpecTools();
    const ctx = fakeCtx();
    const corePath = "user-specs/041-foo/spec.md";
    const cases: [string, Record<string, unknown>][] = [
      ["app_spec_list", { path: "user-specs" }],
      ["app_spec_read", { path: corePath }],
      ["app_spec_write", { path: corePath, content: "x" }],
      ["app_spec_edit", { path: corePath, find: "a", replace: "b" }],
      ["app_spec_patch", { path: corePath, hunks: [{ find: "a", replace: "b" }] }],
    ];
    for (const [name, input] of cases) {
      const result = await tools[name].execute(input, ctx);
      expect(String(result), name).toContain("only operates on marketplace-item specs");
      expect(String(result), name).toContain("file_");
    }
  } finally {
    cleanup();
  }
});
