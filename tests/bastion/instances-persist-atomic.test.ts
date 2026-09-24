// Reproduction: a full disk turned every page of every user's BOS into this,
// on a box where nothing was actually broken but free space:
//
//   Error: Unknown system error -122: Unknown system error -122, open '/data/instances.json'
//       at Object.writeFileSync (node:fs:2380:20)
//       at persistInstancesToDisk (/app/dist/lifecycle.js:353:18)
//       at updateState (/app/dist/lifecycle.js:348:5)
//       at touchInstance (/app/dist/lifecycle.js:224:5)
//       at routeToUser (/app/dist/proxy.js:290:43)
//       at middleware (/app/dist/proxy.js:494:9)
//
// (-122 is EDQUOT, which Node has no name for.) Three defects meet in that
// stack:
//
//   1. `persistInstancesToDisk` used a bare `fs.writeFileSync`. O_TRUNC empties
//      the file before the write is attempted, so a failed write leaves a
//      ZERO-BYTE registry — `/data/instances.json` was found at 0 bytes.
//      Everything under data/ is supposed to be written temp-then-rename.
//   2. It ran on EVERY proxied request, synchronously, via
//      `routeToUser -> touchInstance -> updateState`, to record a "last active"
//      timestamp that exists only to decorate the admin UI.
//   3. Its failure propagated out of the proxy middleware, so a cosmetic
//      timestamp took the whole proxy down for every user.
//
// Driven through the real public API (initLifecycle / touchInstance /
// getAllInstances) rather than the private writer, because the defect is in
// what the request path does, not in what a helper does when called directly.
//
//   npm run test:unit -- tests/bastion/instances-persist-atomic.test.ts
import { test, expect } from "@playwright/test";
import { join } from "path";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, readdirSync, chmodSync, statSync } from "fs";
import { tmpdir } from "os";

type Lifecycle = typeof import("../../bastion/src/lifecycle");

/** The registry lives in a module-level Map, and Playwright reuses worker
 *  processes across files — each test needs its own module instance. Same
 *  require-cache reset used by tests/agent/seed-sync.test.ts. */
/* eslint-disable @typescript-eslint/no-require-imports */
const LIFECYCLE = "../../bastion/src/lifecycle";
function freshLifecycle(): Lifecycle {
  delete require.cache[require.resolve(LIFECYCLE)];
  return require(LIFECYCLE) as Lifecycle;
}

const SEED = [
  { username: "alex", status: "running", lastActive: 1, containerId: "abc" },
  { username: "bosin", status: "stopped", lastActive: 2 },
];

function useDataDir() {
  const dir = mkdtempSync(join(tmpdir(), "bastion-instances-"));
  const file = join(dir, "instances.json");
  writeFileSync(file, JSON.stringify(SEED, null, 2));
  return {
    dir,
    file,
    cfg: { dataDir: dir } as never,
    lifecycle() {
      const mod = freshLifecycle();
      mod.initLifecycle(this.cfg);
      mod.stopHealthMonitor(); // no polling wanted in a unit test
      return mod;
    },
    /** Make the LIVE registry file unwritable in place, while the directory
     *  stays writable. A temp-then-rename write sails through this (rename
     *  replaces the entry; it never opens the target for writing); an
     *  in-place `writeFileSync` cannot. That difference IS the crash-safety
     *  property — the production file went to 0 bytes precisely because the
     *  live file was opened with O_TRUNC. */
    freezeFile: () => chmodSync(file, 0o444),
    /** Make every write fail outright, whatever the strategy: the target path
     *  is a directory, so both `writeFileSync` and `rename` get EISDIR. Stands
     *  in for the EDQUOT the production box hit. */
    breakTarget: () => {
      rmSync(file, { force: true });
      mkdirSync(file);
    },
    cleanup: () => {
      chmodSync(dir, 0o755);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("the live registry file is never opened for writing — the update lands by rename", async () => {
  const d = useDataDir();
  try {
    const lifecycle = d.lifecycle();
    d.freezeFile(); // read-only FILE, writable directory

    lifecycle.touchInstance("alex");

    const persisted = JSON.parse(readFileSync(d.file, "utf8")) as { username: string; lastActive: number }[];
    const alex = persisted.find((i) => i.username === "alex");
    expect(
      alex?.lastActive,
      "a temp-then-rename write replaces the directory entry and never opens the live file; an in-place writeFileSync is what left the production registry at 0 bytes",
    ).toBeGreaterThan(1);
    expect(statSync(d.file).size).toBeGreaterThan(0);
  } finally {
    d.cleanup();
  }
});

test("a failing persist never propagates into the caller — the proxy must not 500 over a cosmetic timestamp", async () => {
  const d = useDataDir();
  try {
    const lifecycle = d.lifecycle();
    d.breakTarget();

    // touchInstance is called by routeToUser on EVERY proxied request. Its
    // failure took down every page for every user on a box whose only problem
    // was free space.
    expect(() => lifecycle.touchInstance("alex")).not.toThrow();
  } finally {
    d.cleanup();
  }
});

test("a failed persist is reported, not silently discarded", async () => {
  const d = useDataDir();
  try {
    const lifecycle = d.lifecycle();
    d.breakTarget();

    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
    try {
      lifecycle.touchInstance("alex");
    } finally {
      console.error = original;
    }

    // Containment is a decision, not an excuse: the registry is a cache that
    // reconcileOnStartup rebuilds from `docker ps`, so losing a write is
    // survivable — but it must never be invisible.
    expect(errors.join("\n")).toMatch(/instances\.json|registry/i);
  } finally {
    d.cleanup();
  }
});

test("a failed atomic write cleans up its own staging file", async () => {
  const d = useDataDir();
  try {
    const lifecycle = d.lifecycle();
    // Break the target BEFORE any successful write, so this touch genuinely
    // attempts (and fails) a persist rather than being coalesced away.
    d.breakTarget();

    lifecycle.touchInstance("alex");

    expect(readdirSync(d.dir).sort(), "a temp file left behind on every failed write is a slow leak in the same directory that just ran out of space").toEqual(["instances.json"]);
  } finally {
    d.cleanup();
  }
});

test("a successful write leaves no staging file", async () => {
  const d = useDataDir();
  try {
    const lifecycle = d.lifecycle();
    lifecycle.touchInstance("alex");
    expect(readdirSync(d.dir)).toEqual(["instances.json"]);
  } finally {
    d.cleanup();
  }
});

test("a burst of proxied requests does not rewrite the registry once per request", async () => {
  const d = useDataDir();
  try {
    const lifecycle = d.lifecycle();

    lifecycle.touchInstance("alex"); // leading edge — recorded at once
    const afterFirst = statSync(d.file).mtimeMs;

    // Every proxied request calls touchInstance: every page, every asset,
    // every poll. Rewriting the whole registry synchronously that often is
    // what put a disk-space failure in the request path to begin with.
    for (let i = 0; i < 200; i++) lifecycle.touchInstance("alex");

    expect(statSync(d.file).mtimeMs, "the burst must be coalesced, not written 200 times").toBe(afterFirst);
    // …and the in-memory value, which is what the admin UI actually reads
    // through getAllInstances, is still current.
    const alex = lifecycle.getAllInstances().find((i) => i.username === "alex");
    expect(alex?.lastActive).toBeGreaterThan(1);
  } finally {
    d.cleanup();
  }
});

test("the registry still round-trips: a touch persists and reloads", async () => {
  const d = useDataDir();
  try {
    const lifecycle = d.lifecycle();
    lifecycle.touchInstance("alex");

    const reloaded = d.lifecycle();
    const names = reloaded.getAllInstances().map((i) => i.username).sort();
    expect(names).toEqual(["alex", "bosin"]);
    const alex = reloaded.getAllInstances().find((i) => i.username === "alex");
    expect(alex?.containerId, "persisting must not drop fields it doesn't understand").toBe("abc");
    expect(alex?.lastActive, "and the touch itself must have been recorded").toBeGreaterThan(1);
  } finally {
    d.cleanup();
  }
});
