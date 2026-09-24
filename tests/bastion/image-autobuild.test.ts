// bastion/src/docker.ts automatic image build (ensureBosImage) and the shared
// single-flight build guard.
//   npx playwright test -c playwright.unit.config.ts tests/bastion/image-autobuild.test.ts
//
// Regression cover for: creating a user in the admin portal and then logging in
// as them failed on a deployment whose `bosImage` had never been built, with
// the daemon's "No such image: <tag>" from docker.createContainer. Nothing
// established that image automatically, so an operator had to notice and press
// "Build image" in the admin portal by hand before ANY user could log in.
// ensureBosImage now runs inside createBosContainer — the single place
// cfg.bosImage is ever used — so first provision, re-provision and
// stale-container self-heal are all covered by construction.
//
// These are REAL Docker integration tests: docker.ts constructs its own
// Dockerode against /var/run/docker.sock at module load, so there is nothing to
// fake, and adding a production injection seam purely to avoid a daemon is not
// worth it. They build a trivial `FROM scratch` image (~0.1s) rather than BOS's
// real Dockerfile, and SKIP cleanly when no daemon is reachable — the rest of
// the unit suite touches Docker nowhere, so it must stay runnable without one.

import { test, expect } from "@playwright/test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import {
  ensureBosImage,
  imageExists,
  buildImageCoalesced,
  isBuildInProgress,
} from "../../bastion/src/docker";
import type { Config } from "../../bastion/src/config";

// docker.ts writes build progress through log-store, which throws on an
// uninitialised data dir unless pointed somewhere writable first.
import { initLogStore } from "../../bastion/src/log-store";

// `dockerode` lives in bastion/'s own node_modules, which this root-level test
// file cannot resolve by directory-walk (bastion/src/docker.ts can, being
// inside it). Resolve it AS bastion would rather than adding a root dependency.
interface MinimalDocker {
  ping(): Promise<unknown>;
  getImage(tag: string): { remove(opts: { force: boolean }): Promise<unknown> };
  getNetwork(name: string): { remove(): Promise<unknown> };
  getVolume(name: string): { remove(opts: { force: boolean }): Promise<unknown> };
  getContainer(name: string): { remove(opts: { force: boolean }): Promise<unknown> };
}
const Dockerode = createRequire(path.join(__dirname, "..", "..", "bastion", "src", "docker.ts"))(
  "dockerode",
) as new (opts: { socketPath: string }) => MinimalDocker;

function daemon(): MinimalDocker {
  return new Dockerode({ socketPath: "/var/run/docker.sock" });
}

let dockerAvailable = false;
let skipReason = "";

test.beforeAll(async () => {
  initLogStore(await fs.mkdtemp(path.join(os.tmpdir(), "bos-img-logs-")));
  try {
    await daemon().ping();
    dockerAvailable = true;
  } catch (err) {
    // Surfaced in the skip reason rather than swallowed: a silently skipped
    // suite that everyone assumes is passing is worse than no suite.
    skipReason = `no Docker daemon reachable: ${(err as Error).message}`;
  }
});

function uniqueTag(prefix: string): string {
  return `bos-autobuild-test-${prefix}-${randomBytes(5).toString("hex")}:v0`;
}

/** A build context whose Dockerfile produces a real (but empty) image fast. */
async function makeContext(dockerfileBody: string): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bos-img-ctx-"));
  await fs.writeFile(path.join(dir, "marker.txt"), "marker\n");
  await fs.writeFile(path.join(dir, "Dockerfile"), dockerfileBody);
  return { dir, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

const TRIVIAL_DOCKERFILE = "FROM scratch\nCOPY marker.txt /\n";

async function removeImage(tag: string): Promise<void> {
  await daemon().getImage(tag).remove({ force: true }).catch(() => {});
}

function makeConfig(overrides: Partial<Config>): Config {
  return {
    port: 3000,
    jwtSecret: "test-jwt-secret",
    authProvider: "simple",
    bosImage: "browseros:latest",
    volumeBase: "/user-data",
    maxConcurrentInstances: 50,
    bosBaseRef: "main",
    bosRepoPath: "/bos-src",
    bosVolumeBaseHost: "/tmp/bos-volume-base-host",
    dataDir: "/tmp/bos-bastion-data",
    bosNet: "bos-net",
    keycloakIssuer: "",
    keycloakClientId: "",
    keycloakClientSecret: "",
    keycloakUsernameClaim: "preferred_username",
    keycloakAdminRole: "bos-admin",
    publicUrl: "http://localhost:3000",
    ...overrides,
  };
}

test.describe("ensureBosImage — the image is established automatically", () => {
  test("builds the configured image when it does not exist yet (the reported bug)", async () => {
    test.skip(!dockerAvailable, skipReason);
    const tag = uniqueTag("missing");
    const { dir, cleanup } = await makeContext(TRIVIAL_DOCKERFILE);
    try {
      // Precondition: this is exactly the state a fresh deployment is in, and
      // the state in which the first login used to die at createContainer.
      expect(await imageExists(tag)).toBe(false);

      const progress: string[] = [];
      await ensureBosImage("alice", makeConfig({ bosImage: tag, bosRepoPath: dir }), (m) => progress.push(m));

      expect(await imageExists(tag)).toBe(true);
      // The user is told what is happening — a multi-minute silent wait on the
      // status page is what made the original failure look like a hang.
      expect(progress.join("\n")).toContain("not found");
      expect(progress.join("\n")).toContain("Image");
      expect(progress[progress.length - 1]).toContain("is ready");
    } finally {
      await removeImage(tag);
      await cleanup();
    }
  });

  test("is a no-op when the image already exists (no rebuild on every login)", async () => {
    test.skip(!dockerAvailable, skipReason);
    const tag = uniqueTag("present");
    const { dir, cleanup } = await makeContext(TRIVIAL_DOCKERFILE);
    try {
      const cfg = makeConfig({ bosImage: tag, bosRepoPath: dir });
      await ensureBosImage("alice", cfg);
      expect(await imageExists(tag)).toBe(true);

      // Second call must not build again — every container creation goes
      // through here, so a rebuild-per-call would be catastrophic.
      const progress: string[] = [];
      await ensureBosImage("alice", cfg, (m) => progress.push(m));
      expect(progress).toEqual([]);
    } finally {
      await removeImage(tag);
      await cleanup();
    }
  });

  test("a failing build surfaces a diagnosable error naming the tag and the context", async () => {
    test.skip(!dockerAvailable, skipReason);
    const tag = uniqueTag("broken");
    // A Dockerfile the daemon rejects outright.
    const { dir, cleanup } = await makeContext("FROM scratch\nRUN this-command-cannot-run\n");
    try {
      const progress: string[] = [];
      const err = await ensureBosImage("alice", makeConfig({ bosImage: tag, bosRepoPath: dir }), (m) =>
        progress.push(m),
      ).then(() => null, (e: Error) => e);

      expect(err).not.toBeNull();
      // "could not be built automatically" + the tag + the context path: enough
      // for an operator to act on without reading bastion's source.
      expect(err?.message).toContain(tag);
      expect(err?.message).toContain(dir);
      expect(err?.message).toContain("could not be built automatically");
      expect(progress.join("\n")).toContain("FAILED");
      // And it must not silently leave a half-built tag behind that later
      // reads as "image is fine".
      expect(await imageExists(tag)).toBe(false);
    } finally {
      await removeImage(tag);
      await cleanup();
    }
  });
});

test.describe("createBosContainer wiring — the choke point actually calls it", () => {
  test("creating a container establishes the image first, without the caller asking", async () => {
    test.skip(!dockerAvailable, skipReason);
    // The regression point: ensureBosImage working is useless if the one place
    // that consumes cfg.bosImage doesn't invoke it. Drive the real
    // createBosContainer and assert the image appears as a side effect —
    // covering first provision, re-provision and self-heal in one go, since
    // all four call sites funnel through here.
    const { createBosContainer } = await import("../../bastion/src/docker");
    const tag = uniqueTag("wiring");
    const username = `imgtest${randomBytes(4).toString("hex")}`;
    const net = `bos-imgtest-net-${randomBytes(4).toString("hex")}`;
    const volumeBase = await fs.mkdtemp(path.join(os.tmpdir(), "bos-img-vol-"));
    const { dir, cleanup } = await makeContext(TRIVIAL_DOCKERFILE);
    try {
      expect(await imageExists(tag)).toBe(false);

      const cfg = makeConfig({
        bosImage: tag,
        bosRepoPath: dir,
        bosNet: net,
        volumeBase,
        bosVolumeBaseHost: volumeBase,
      });
      // May resolve (container created but never started) or reject on this
      // host's mount setup — either way the image must exist afterwards, which
      // is the only thing under test here.
      await createBosContainer(username, cfg).catch(() => {});

      expect(await imageExists(tag)).toBe(true);
    } finally {
      await daemon().getContainer(`bos-${username}`).remove({ force: true }).catch(() => {});
      await daemon().getVolume(`bos-nm-${username}`).remove({ force: true }).catch(() => {});
      await daemon().getNetwork(net).remove().catch(() => {});
      await removeImage(tag);
      await cleanup();
      await fs.rm(volumeBase, { recursive: true, force: true });
    }
  });
});

test.describe("build single-flight — one build per tag, shared by every caller", () => {
  test("concurrent same-tag builds coalesce onto one build", async () => {
    test.skip(!dockerAvailable, skipReason);
    const tag = uniqueTag("coalesce");
    const { dir, cleanup } = await makeContext(TRIVIAL_DOCKERFILE);
    try {
      // Two callers racing is the real scenario: two users logging in for the
      // first time at once, or an admin "Build image" racing a first login.
      let starters = 0;
      const start = (): Promise<void> =>
        buildImageCoalesced(dir, "Dockerfile", tag, (event) => {
          if (event.line) starters++;
        });

      const a = start();
      const b = start();
      // Same promise: the second caller joined rather than starting a build.
      expect(a).toBe(b);
      expect(isBuildInProgress()).toBe(true);

      await Promise.all([a, b]);

      expect(await imageExists(tag)).toBe(true);
      expect(isBuildInProgress()).toBe(false);
      expect(starters).toBeGreaterThan(0);
    } finally {
      await removeImage(tag);
      await cleanup();
    }
  });

  test("the in-flight entry is released after a FAILED build, so a retry is possible", async () => {
    test.skip(!dockerAvailable, skipReason);
    const tag = uniqueTag("release");
    const { dir, cleanup } = await makeContext("FROM scratch\nRUN this-command-cannot-run\n");
    try {
      await buildImageCoalesced(dir, "Dockerfile", tag, () => {}).catch(() => {});
      // A leaked entry here would wedge the admin portal's build button on 409
      // "a build is already in progress" forever.
      expect(isBuildInProgress()).toBe(false);
    } finally {
      await removeImage(tag);
      await cleanup();
    }
  });
});
