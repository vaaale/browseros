// Reproduction: a directory at the clone path is not the same thing as a clone.
//
// `provisionClone` decided "already provisioned" by asking whether the target
// directory exists:
//
//     if (await fs.stat(target).catch(() => null)) return { method: "existing" };
//
// The staging-and-rename dance protects that check from a half-finished COPY —
// `target` only ever appears once the copy is complete. It does not protect it
// from a directory created by somebody ELSE. Found in production:
//
//     /data-clones/bos/switch-telegram-auto-reply   195K
//       events/  user-apps/  vfs/
//
// against a canonical data dir holding agents/, config/, marketplace/, skills/,
// integrations/, logs/ and a dozen more. That is not a clone: it is the
// residue of `mountCoupled` mounting user-apps at the clone path and the
// preview's own server writing `events/` and `vfs/` — after the real clone had
// been deleted out from under the in-memory preview record. From then on every
// `provisionClone` for that branch returned "existing", so the preview would
// run forever against a data dir with no config, no agents and no installed
// items, and nothing anywhere would report it.
//
// A completion MARKER written inside the clone before the rename makes the
// question answerable instead of guessed. And because real clones already
// exist in the field without one, a marker-less directory is not simply
// destroyed: if it carries everything the source has it is ADOPTED (the
// marker is written, its content and any drift left alone); if it is missing
// entries it is the stub above and gets rebuilt.
//
//   node --test tests/supervisor/clone-completeness.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { makeSupervisorEnv } from "./_data-helpers.mjs";

const env = makeSupervisorEnv("clone-complete-");
const { provisionClone, CLONE_COMPLETE_MARKER } = await import("../../tools/supervisor/lib/worktree.mjs");
const { initLogStore, getLogStore } = await import("../../tools/supervisor/lib/log.mjs");
initLogStore(env.dataDir);
await getLogStore()._ready;

// A canonical data dir with the breadth a real one has — the stub in
// production had three of these and was accepted as a finished clone.
for (const d of ["vfs", "config", "agents", "marketplace", "skills", "events", "user-apps"]) {
  mkdirSync(join(env.dataDir, d), { recursive: true });
  writeFileSync(join(env.dataDir, d, "marker.txt"), `${d} content\n`);
}

test("a completed clone carries the marker", async () => {
  const target = join(env.clones, "fresh");
  const result = await provisionClone(target);

  assert.notEqual(result.method, "existing");
  assert.equal(existsSync(join(target, CLONE_COMPLETE_MARKER)), true, "the marker is what makes completeness checkable at all");
  assert.equal(await readFile(join(target, "config", "marker.txt"), "utf8"), "config content\n");
});

test("a marked clone is a no-op on re-provision, drift and all", async () => {
  const target = join(env.clones, "marked");
  await provisionClone(target);
  writeFileSync(join(target, "DRIFT"), "the preview wrote this\n");

  const second = await provisionClone(target);

  assert.equal(second.method, "existing");
  assert.equal(existsSync(join(target, "DRIFT")), true, "a finished clone must never be re-copied over");
});

test("the production stub — a directory holding only what other writers made — is rebuilt, not trusted", async () => {
  // Exactly the shape found on the box: three of the source's entries, and
  // they are the three that mountCoupled and a running preview create.
  const target = join(env.clones, "stub");
  for (const d of ["events", "user-apps", "vfs"]) {
    mkdirSync(join(target, d), { recursive: true });
    writeFileSync(join(target, d, "written-by-someone-else.txt"), "not a clone\n");
  }
  assert.equal(existsSync(join(target, "config")), false, "precondition: the stub is missing most of the data dir");

  const result = await provisionClone(target);

  assert.notEqual(result.method, "existing", "a stub must not be reported as an already-provisioned clone");
  assert.equal(existsSync(join(target, CLONE_COMPLETE_MARKER)), true);
  // The whole point: a preview on this clone can now see its config and agents.
  for (const d of ["config", "agents", "marketplace", "skills"]) {
    assert.equal(
      await readFile(join(target, d, "marker.txt"), "utf8"),
      `${d} content\n`,
      `${d}/ must be present — a preview running without it has no config, no agents and no installed items`,
    );
  }
});

test("a pre-existing complete clone with no marker is ADOPTED, never rebuilt over", async () => {
  // Every clone already on disk when this change ships is in this state.
  // Rebuilding it would throw away whatever the preview had written.
  const target = join(env.clones, "legacy");
  for (const d of readdirSync(env.dataDir)) {
    mkdirSync(join(target, d), { recursive: true });
    writeFileSync(join(target, d, "marker.txt"), `${d} content\n`);
  }
  writeFileSync(join(target, "DRIFT"), "months of preview state\n");
  assert.equal(existsSync(join(target, CLONE_COMPLETE_MARKER)), false, "precondition: no marker, like every clone in the field");

  const result = await provisionClone(target);

  assert.equal(result.method, "existing", "a clone that has everything the source has is complete, marker or not");
  assert.equal(existsSync(join(target, "DRIFT")), true, "adoption must not touch the content");
  assert.equal(existsSync(join(target, CLONE_COMPLETE_MARKER)), true, "…and must record the answer so the scan happens once");
});

test("an adopted clone is then treated as marked — the expensive check does not repeat", async () => {
  const target = join(env.clones, "legacy2");
  for (const d of readdirSync(env.dataDir)) mkdirSync(join(target, d), { recursive: true });
  await provisionClone(target); // adopts

  // Remove an entry AFTER adoption: a marked clone is trusted outright, so
  // this must still be a no-op rather than a surprise rebuild of a live
  // preview's data dir.
  const second = await provisionClone(target);
  assert.equal(second.method, "existing");
});

test.after(() => env.cleanup());
