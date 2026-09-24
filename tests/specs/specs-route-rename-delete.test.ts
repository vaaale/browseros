// Wiring tests for /api/specs's DELETE/PATCH (rename) operations
// (037-project-layer, Phase 4) — Build Studio's UI reads/writes through this
// route (dev/spec-fs.ts), a separate path from the VFS file_rename/file_delete
// tools (os/fs/spec-fs.ts) Phase 5 added. Both gated by the same rule as any
// write: a real feature `branch` (the same `bos/*` branch used for BOS's own
// source — there is no separate per-Project session anymore) — this only
// verifies the route wiring.
//   npm run test:unit -- tests/specs/specs-route-rename-delete.test.ts
import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { NextRequest } from "next/server";
import { useTestDataDir } from "../services/_test-env";
import { ensureStores } from "../../src/lib/specs/seed";
import { createProject } from "../../src/lib/specs/projects";
import * as specfs from "../../src/lib/dev/spec-fs";
import { DELETE, PATCH } from "../../src/app/api/specs/route";

// Creating a folder is a WRITE like any other now: the `project.json`
// exemption from the feature-branch rule is gone (spec-fs.ts prepareWrite),
// because it let a folder land on a user repository's default branch and
// then refused every attempt to put anything in it.
const BR = { branch: "bos/testfixture-specs-route-delete" };

test("PATCH renames a file through dev/spec-fs.ts's rename", async () => {
  const { cleanup } = useTestDataDir("specs-route-patch-rename");
  try {
    await ensureStores();
    await createProject("user-specs", "Alpha", undefined, BR);
    await specfs.writeFile("user-specs/alpha/001-foo/spec.md", "# Foo\n", { branch: "alpha/work" });

    const res = await PATCH(
      new NextRequest("http://local/api/specs", {
        method: "PATCH",
        body: JSON.stringify({ path: "user-specs/alpha/001-foo/spec.md", to: "user-specs/alpha/001-foo/renamed.md", branch: "alpha/work" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await specfs.exists("user-specs/alpha/001-foo/renamed.md")).toBe(true);
    expect(await specfs.exists("user-specs/alpha/001-foo/spec.md")).toBe(false);
  } finally {
    cleanup();
  }
});

test("DELETE removes a file through dev/spec-fs.ts's remove", async () => {
  const { cleanup } = useTestDataDir("specs-route-delete");
  try {
    await ensureStores();
    await createProject("user-specs", "Alpha", undefined, BR);
    await specfs.writeFile("user-specs/alpha/001-foo/notes.md", "scratch\n", { branch: "alpha/work" });

    const res = await DELETE(
      new NextRequest(`http://local/api/specs?path=${encodeURIComponent("user-specs/alpha/001-foo/notes.md")}&branch=${encodeURIComponent("alpha/work")}`),
    );
    expect(res.status).toBe(200);
    expect(await specfs.exists("user-specs/alpha/001-foo/notes.md")).toBe(false);
  } finally {
    cleanup();
  }
});

test("DELETE and PATCH are refused with no feature branch given, same as a write", async () => {
  const { cleanup } = useTestDataDir("specs-route-rename-delete-gated");
  try {
    await ensureStores();
    await createProject("user-specs", "Alpha", undefined, BR);

    const del = await DELETE(new NextRequest(`http://local/api/specs?path=${encodeURIComponent("user-specs/alpha/001-foo/spec.md")}`));
    expect(del.status).toBe(400);
    expect((await del.json()).error).toContain("feature branch");

    const patch = await PATCH(
      new NextRequest("http://local/api/specs", {
        method: "PATCH",
        body: JSON.stringify({ path: "user-specs/alpha/001-foo/spec.md", to: "user-specs/alpha/001-foo/x.md" }),
      }),
    );
    expect(patch.status).toBe(400);
    expect((await patch.json()).error).toContain("feature branch");
  } finally {
    cleanup();
  }
});
