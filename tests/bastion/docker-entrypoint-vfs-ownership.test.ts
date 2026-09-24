// docker-entrypoint.sh must not leave any directory it creates under the data
// bind-mount owned by root — BOS itself runs as "user" (uid BOS_UID).
//   npm run test:unit -- tests/bastion/docker-entrypoint-vfs-ownership.test.ts
//
// Regression cover for: a freshly provisioned Dokploy user ("bosin") came up
// healthy but the memory plugin logged
//   "memory plugin: failed to seed scheduler jobs"
//   EACCES: permission denied, mkdir '/app/data/vfs/Pictures'
// and the container showed
//   drwxr-xr-x 4 0    0    /app/data/vfs
//   drwxr-xr-x 4 1000 1000 /app/data/vfs/Documents
//   drwxr-xr-x 2 1000 1000 /app/data/vfs/workspace
//
// The cause is ordering inside the entrypoint. `chown -R user:user /app/data`
// runs FIRST (and only when /app/data's own owner differs from BOS_UID), and
// only afterwards does the VFS-symlink block, still root, run
//   mkdir -p "$BOS_DATA_DIR/vfs/$_dir"   # implicitly creates .../vfs as root
//   chown -R user:user "$BOS_DATA_DIR/vfs/$_dir"   # ... chowns only the LEAF
// so the vfs root stays root-owned and ensureVfs() in src/os/vfs.ts cannot
// create the remaining VFS dirs (Pictures, Desktop, the mount stubs) inside it.
// It is not self-repairing either: on the next start /app/data's own owner is
// already 1000, so the conditional `chown -R` is skipped.
//
// The test runs the real script under `sh` with the privileged commands
// replaced by recording shims on PATH (the suite has no root and must not chown
// anything), and replays the recorded mkdir/chown sequence: every directory the
// script creates must be covered by a LATER chown. No network, no Docker.

import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const ENTRYPOINT = path.join(REPO_ROOT, "docker-entrypoint.sh");

/** A recording stand-in for a command the entrypoint runs as root. */
async function writeShim(binDir: string, name: string, body: string): Promise<void> {
  const file = path.join(binDir, name);
  await fs.writeFile(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

type Event = { cmd: "mkdir" | "chown"; recursive: boolean; target: string };

function parseLog(raw: string): Event[] {
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [cmd, rest] = [line.slice(0, line.indexOf(" ")), line.slice(line.indexOf(" ") + 1)];
      if (cmd === "mkdir") return { cmd, recursive: false, target: rest } as Event;
      const recursive = rest.startsWith("1 ");
      return { cmd: "chown", recursive, target: rest.slice(2) } as Event;
    });
}

/**
 * Replay the script's mkdir/chown sequence and return the directories it
 * created that no subsequent chown handed to "user" — i.e. the ones left
 * root-owned inside a bind-mount the BOS process must be able to write.
 */
function rootOwnedLeftovers(events: Event[]): string[] {
  const pending = new Set<string>();
  for (const ev of events) {
    if (ev.cmd === "mkdir") {
      pending.add(ev.target);
      continue;
    }
    pending.delete(ev.target);
    if (ev.recursive) {
      for (const p of pending) if (p.startsWith(`${ev.target}/`)) pending.delete(p);
    }
  }
  return [...pending];
}

test("docker-entrypoint.sh leaves no root-owned directory under the data mount", async () => {
  const tmp = path.join(os.tmpdir(), `bos-entrypoint-${randomBytes(6).toString("hex")}`);
  const binDir = path.join(tmp, "bin");
  const dataDir = path.join(tmp, "data");
  const logFile = path.join(tmp, "shim.log");
  // The bastion creates the data dir (fs.mkdirSync in provision.ts) before the
  // container ever starts, so it is not one of the script's own creations.
  await fs.mkdir(binDir, { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(logFile, "");

  try {
    // mkdir: record every directory that does not yet exist (ancestors first,
    // as `mkdir -p` creates them), then do the real thing.
    await writeShim(
      binDir,
      "mkdir",
      [
        // Walk up to the first existing ancestor, accumulating leaf-first, then
        // emit ancestors-first. Iterative on purpose: `sh` has no local
        // variables, so a recursive version clobbers its own loop state.
        "log_missing() {",
        '  missing=""',
        '  p="$1"',
        '  while [ ! -d "$p" ]; do',
        '    missing="$p',
        '$missing"',
        '    np=$(dirname "$p")',
        '    [ "$np" = "$p" ] && break',
        '    p="$np"',
        "  done",
        '  printf "%s" "$missing" | while read -r m; do',
        '    [ -n "$m" ] && echo "mkdir $m" >> "$SHIM_LOG"',
        "  done",
        "}",
        'for a in "$@"; do',
        '  case "$a" in -*) continue;; esac',
        '  log_missing "$a"',
        "done",
        'exec /bin/mkdir "$@"',
      ].join("\n"),
    );
    // chown: record "<recursive> <path>" per target and succeed. The suite is
    // not root, so it must never actually change ownership.
    await writeShim(
      binDir,
      "chown",
      [
        "recursive=0",
        'owner=""',
        'for a in "$@"; do',
        '  case "$a" in',
        '    -*) case "$a" in *R*) recursive=1;; esac; continue;;',
        "  esac",
        '  if [ -z "$owner" ]; then owner="$a"; continue; fi',
        '  echo "chown $recursive $a" >> "$SHIM_LOG"',
        "done",
        "exit 0",
      ].join("\n"),
    );
    // The account already exists (a plain restart), so groupadd/useradd are
    // skipped; stat reports root so both conditional chowns are taken; gosu,
    // npm and ln must not run for real.
    await writeShim(binDir, "getent", "exit 0");
    await writeShim(binDir, "id", "exit 0");
    await writeShim(binDir, "stat", 'echo "0"');
    await writeShim(binDir, "gosu", "exit 0");
    await writeShim(binDir, "npm", "exit 0");
    await writeShim(binDir, "ln", "exit 0");

    execFileSync("sh", [ENTRYPOINT], {
      cwd: tmp,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        SHIM_LOG: logFile,
        BOS_DATA_DIR: dataDir,
      },
      stdio: "pipe",
    });

    const events = parseLog(await fs.readFile(logFile, "utf8"));
    // Guard the guard: if the shims silently recorded nothing, the assertion
    // below would pass vacuously.
    expect(events.filter((e) => e.cmd === "mkdir").map((e) => e.target)).toContain(
      path.join(dataDir, "vfs", "workspace"),
    );

    expect(rootOwnedLeftovers(events)).toEqual([]);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
