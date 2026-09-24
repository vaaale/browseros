// Unit tests for src/lib/specs/seed.ts's store manifest seeding — in
// particular ensureUserStore()'s identity enforcement, added after a real
// bug report: a user copied bos-system-specs' entire directory content into
// user-specs/ to get a working copy of its specs, which brought
// bos-system-specs' own spec-store.json along too (`owner: "system",
// writable: false`). Because ensureUserStore() used to only write the user
// manifest when NONE existed yet, that copy permanently mislabeled
// user-specs as the (now, post-redesign, fully) read-only system store —
// Build Studio showed no context menu on it at all, with no way to recover
// short of hand-editing the JSON file.
//   npm run test:unit -- tests/specs/seed.test.ts
import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { join } from "path";
import { readFile, writeFile, mkdir } from "fs/promises";
import { useTestDataDir } from "../services/_test-env";
import { specsRoot } from "../../src/os/specs-dir";
import { ensureStores } from "../../src/lib/specs/seed";
import { getStore } from "../../src/lib/specs/stores";

test("fresh boot seeds user-specs with the correct owner/writable identity", async () => {
  const { cleanup } = useTestDataDir("seed-user-store-fresh");
  try {
    await ensureStores();
    const store = await getStore("user-specs");
    expect(store).toMatchObject({ owner: "user", writable: true, requiresPromote: false, label: "User specs" });
  } finally {
    cleanup();
  }
});

test("a user-specs manifest copied wholesale from bos-system-specs is corrected back to the user identity on the next ensureStores()", async () => {
  const { cleanup } = useTestDataDir("seed-user-store-mislabeled");
  try {
    const root = specsRoot();
    const userDir = join(root, "user-specs");
    await mkdir(userDir, { recursive: true });
    // Simulates copying bos-system-specs' own spec-store.json into user-specs/.
    await writeFile(
      join(userDir, "spec-store.json"),
      JSON.stringify({ label: "System specs", owner: "system", writable: false, requiresPromote: true }, null, 2),
    );

    await ensureStores();

    const store = await getStore("user-specs");
    expect(store?.owner).toBe("user");
    expect(store?.writable).toBe(true);
    expect(store?.requiresPromote).toBe(false);
  } finally {
    cleanup();
  }
});

test("a legitimately customized user-specs label survives, even though owner/writable are still enforced", async () => {
  const { cleanup } = useTestDataDir("seed-user-store-custom-label");
  try {
    const root = specsRoot();
    const userDir = join(root, "user-specs");
    await mkdir(userDir, { recursive: true });
    await writeFile(
      join(userDir, "spec-store.json"),
      JSON.stringify({ label: "My Customizations", owner: "user", writable: true, requiresPromote: false }, null, 2),
    );

    await ensureStores();

    const store = await getStore("user-specs");
    expect(store?.label).toBe("My Customizations");
    expect(store?.owner).toBe("user");
  } finally {
    cleanup();
  }
});

test("a store's METHOD and WORKFLOW bindings survive a reseed", async () => {
  // The same bug, twice. 045 FR-008 added `method` to what ensureUserStore
  // preserves, because a method assigned through the picker "would survive
  // exactly until the next restart and then silently revert to spec-kit". 049
  // then made `workflow` the field that supersedes it (`resolveMethod` reads
  // `store.workflow ?? store.method`) and nobody added the new field to the
  // allowlist — so binding a store to a fork, which is how 051 works, reverted
  // on the next boot with no message at all.
  //
  // Both fields are asserted, and `unknownFuture` with them: the manifest now
  // preserves by default and enforces only the three identity fields, so this
  // test fails if anyone reintroduces the allowlist.
  const { cleanup } = useTestDataDir("seed-user-store-bindings");
  try {
    const userDir = join(specsRoot(), "user-specs");
    await mkdir(userDir, { recursive: true });
    await writeFile(
      join(userDir, "spec-store.json"),
      JSON.stringify({
        label: "User specs", owner: "user", writable: true, requiresPromote: false,
        method: "bmad", workflow: "lean", unknownFuture: "keep me",
      }, null, 2),
    );

    await ensureStores();

    const raw = JSON.parse(await readFile(join(userDir, "spec-store.json"), "utf8")) as Record<string, unknown>;
    expect(raw.workflow, "049's binding field — the one that was being dropped").toBe("lean");
    expect(raw.method, "045's, which was already preserved").toBe("bmad");
    expect(raw.unknownFuture, "preserve-by-default, so the next field needs no code change").toBe("keep me");

    const store = await getStore("user-specs");
    expect(store?.workflow).toBe("lean");
    expect(store?.owner, "identity is still enforced").toBe("user");
    expect(store?.writable).toBe(true);
  } finally {
    cleanup();
  }
});

test("bos-system-specs' manifest is always enforced too, even if something wrote it as writable", async () => {
  const { cleanup } = useTestDataDir("seed-system-store-tampered");
  try {
    const root = specsRoot();
    const systemDir = join(root, "bos-system-specs");
    await mkdir(systemDir, { recursive: true });
    await writeFile(
      join(systemDir, "spec-store.json"),
      JSON.stringify({ label: "System specs", owner: "system", writable: true, requiresPromote: true }, null, 2),
    );

    await ensureStores();

    const store = await getStore("bos-system-specs");
    expect(store?.writable).toBe(false);
    const raw = JSON.parse(await readFile(join(systemDir, "spec-store.json"), "utf8"));
    expect(raw.writable).toBe(false);
  } finally {
    cleanup();
  }
});
