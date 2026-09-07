// Unit tests for tools/supervisor/lib/push.mjs's pushWithRecovery — the
// shallow-clone-safe retry BOS uses for both the per-remote "Push" button
// and auto-push-on-promote (see that file's own doc comment: Dokploy
// re-clones `code/` with `--depth 1` on every redeploy, which can leave git
// unable to prove the local branch descends from the remote's even when
// nothing really conflicts).
//
// The "recovers" scenarios use a real `pre-receive` hook on a bare remote
// that rejects exactly the FIRST push and allows the retry — a real,
// deterministic git-level rejection standing in for the transient
// shallow-history rejection the recovery logic is designed to survive
// (the code itself doesn't inspect WHY the first push failed beyond
// auth-vs-not; it only decides whether a retry is SAFE via merge-base +
// is-ancestor).
//   node --test tests/supervisor/push-with-recovery.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { pushWithRecovery } = await import("../../tools/supervisor/lib/push.mjs");

function git(cwd, args) {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();
}

/** Install a pre-receive hook on an EXISTING bare remote that rejects
 *  exactly the next push it receives and allows every push after that.
 *  Installed only after the remote already holds whatever history a test
 *  wants pre-seeded, so seeding itself never trips the rejection. */
function installFlakyHook(remote) {
  mkdirSync(join(remote, "hooks"), { recursive: true });
  writeFileSync(
    join(remote, "hooks", "pre-receive"),
    `#!/bin/sh\nCOUNT_FILE="${remote}/reject-count"\nCOUNT=$(cat "$COUNT_FILE" 2>/dev/null || echo 0)\nif [ "$COUNT" -lt 1 ]; then\n  echo $((COUNT+1)) > "$COUNT_FILE"\n  echo "rejected (simulated transient failure)" >&2\n  exit 1\nfi\nexit 0\n`,
  );
  chmodSync(join(remote, "hooks", "pre-receive"), 0o755);
}

test("pushWithRecovery: a rejected-but-actually-fast-forwardable push recovers via fetch+retry", async () => {
  const remote = mkdtempSync(join(tmpdir(), "push-recovery-remote-"));
  git(remote, ["init", "-q", "--bare"]);
  const seed = mkdtempSync(join(tmpdir(), "push-recovery-seed-"));
  git(seed, ["init", "-q"]);
  writeFileSync(join(seed, "f"), "base\n");
  git(seed, ["add", "-A"]);
  git(seed, ["commit", "-q", "-m", "base"]);
  git(seed, ["push", remote, "HEAD:claude"]); // seed the remote BEFORE the flaky hook exists

  installFlakyHook(remote);
  const local = mkdtempSync(join(tmpdir(), "push-recovery-local-"));
  git(process.cwd(), ["clone", "-q", remote, local]);
  try {
    git(local, ["checkout", "-q", "claude"]);
    writeFileSync(join(local, "g"), "a real, linear feature commit\n");
    git(local, ["add", "-A"]);
    git(local, ["commit", "-q", "-m", "feature"]);

    await pushWithRecovery(local, "origin", "claude");

    assert.equal(git(remote, ["rev-parse", "claude"]), git(local, ["rev-parse", "HEAD"]));
  } finally {
    rmSync(remote, { recursive: true, force: true });
    rmSync(seed, { recursive: true, force: true });
    rmSync(local, { recursive: true, force: true });
  }
});

test("pushWithRecovery: same recovery, but from a genuinely SHALLOW local clone (the unshallow branch)", async () => {
  const remote = mkdtempSync(join(tmpdir(), "push-recovery-shallow-remote-"));
  git(remote, ["init", "-q", "--bare"]);
  const seed = mkdtempSync(join(tmpdir(), "push-recovery-shallow-seed-"));
  git(seed, ["init", "-q"]);
  writeFileSync(join(seed, "f"), "a\n");
  git(seed, ["add", "-A"]);
  git(seed, ["commit", "-q", "-m", "a"]);
  git(seed, ["push", remote, "HEAD:claude"]);
  writeFileSync(join(seed, "f"), "b\n");
  git(seed, ["add", "-A"]);
  git(seed, ["commit", "-q", "-m", "b"]);
  git(seed, ["push", remote, "HEAD:claude"]); // remote now has 2 commits, seeded BEFORE the flaky hook exists

  installFlakyHook(remote);
  const local = mkdtempSync(join(tmpdir(), "push-recovery-shallow-local-"));
  // --depth is silently ignored for a plain local-path clone; file:// forces
  // git to treat it as a real (shallow-capable) transport.
  git(process.cwd(), ["clone", "-q", "--depth", "1", "--branch", "claude", `file://${remote}`, local]);
  try {
    assert.equal(git(local, ["rev-parse", "--is-shallow-repository"]), "true", "precondition: local really is shallow");
    writeFileSync(join(local, "g"), "new work\n");
    git(local, ["add", "-A"]);
    git(local, ["commit", "-q", "-m", "c"]);

    await pushWithRecovery(local, "origin", "claude");

    assert.equal(git(remote, ["rev-parse", "claude"]), git(local, ["rev-parse", "HEAD"]));
  } finally {
    rmSync(remote, { recursive: true, force: true });
    rmSync(seed, { recursive: true, force: true });
    rmSync(local, { recursive: true, force: true });
  }
});

test("pushWithRecovery: no shared history at all — refuses to guess, throws a clear error", async () => {
  const remote = mkdtempSync(join(tmpdir(), "push-recovery-unrelated-remote-"));
  git(remote, ["init", "-q", "--bare"]);
  const remoteSeed = mkdtempSync(join(tmpdir(), "push-recovery-unrelated-seed-"));
  git(remoteSeed, ["init", "-q"]);
  writeFileSync(join(remoteSeed, "remote-file"), "remote root\n");
  git(remoteSeed, ["add", "-A"]);
  git(remoteSeed, ["commit", "-q", "-m", "remote root"]);
  git(remoteSeed, ["push", remote, "HEAD:claude"]);

  const local = mkdtempSync(join(tmpdir(), "push-recovery-unrelated-local-"));
  git(local, ["init", "-q"]);
  writeFileSync(join(local, "local-file"), "unrelated local root\n");
  git(local, ["add", "-A"]);
  git(local, ["commit", "-q", "-m", "unrelated local root"]);
  git(local, ["remote", "add", "origin", remote]);
  try {
    await assert.rejects(
      pushWithRecovery(local, "origin", "claude"),
      /no shared history was found/,
    );
  } finally {
    rmSync(remote, { recursive: true, force: true });
    rmSync(remoteSeed, { recursive: true, force: true });
    rmSync(local, { recursive: true, force: true });
  }
});

test("pushWithRecovery: shared history but genuinely diverged — refuses to guess, throws a clear divergence error", async () => {
  const remote = mkdtempSync(join(tmpdir(), "push-recovery-diverged-remote-"));
  git(remote, ["init", "-q", "--bare"]);
  const seed = mkdtempSync(join(tmpdir(), "push-recovery-diverged-seed-"));
  git(seed, ["init", "-q"]);
  writeFileSync(join(seed, "f"), "base\n");
  git(seed, ["add", "-A"]);
  git(seed, ["commit", "-q", "-m", "base"]);
  git(seed, ["push", remote, "HEAD:claude"]);

  const local = mkdtempSync(join(tmpdir(), "push-recovery-diverged-local-"));
  git(process.cwd(), ["clone", "-q", remote, local]);
  git(local, ["checkout", "-q", "claude"]);

  // Remote advances independently (simulates another environment pushing).
  writeFileSync(join(seed, "f"), "remote advanced\n");
  git(seed, ["add", "-A"]);
  git(seed, ["commit", "-q", "-m", "remote advances"]);
  git(seed, ["push", remote, "HEAD:claude"]);

  // Local ALSO advances, diverging from the remote's new tip.
  writeFileSync(join(local, "g"), "local advanced\n");
  git(local, ["add", "-A"]);
  git(local, ["commit", "-q", "-m", "local advances"]);

  try {
    await assert.rejects(
      pushWithRecovery(local, "origin", "claude"),
      /genuinely diverged/,
    );
  } finally {
    rmSync(remote, { recursive: true, force: true });
    rmSync(seed, { recursive: true, force: true });
    rmSync(local, { recursive: true, force: true });
  }
});

test.after(() => {});
