// manifestValidator: validateManifest / validateServiceJson / validateManifestAtStart
//   npx playwright test -c playwright.unit.config.ts tests/services/manifestValidator.test.ts
import "./_stub-server-only";
import { test, expect } from "@playwright/test";
import { join } from "path";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "fs";
import {
  validateManifest,
  validateServiceJson,
  validateManifestAtStart,
} from "../../src/core/service/manifestValidator";

const TMP = join(__dirname, ".tmp-manifest-validator");

function freshItemDir(name: string): string {
  const dir = join(TMP, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

const VALID: Record<string, unknown> = { id: "my-svc", name: "My Service", version: "1.0.0", entry: "index.js" };

test.describe("validateManifest — valid manifests", () => {
  test("accepts a minimal valid manifest (no itemDir → skips entry existence check)", async () => {
    const result = await validateManifest(VALID);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("accepts a manifest with dependencies, configSchema, settingsRegistration", async () => {
    const result = await validateManifest({
      ...VALID,
      configSchema: { type: "object", properties: { port: { type: "number" } } },
      dependencies: ["other-svc"],
      settingsRegistration: { label: "My Service" },
    });
    expect(result.valid).toBe(true);
  });

  test("accepts ids with dots, hyphens, underscores", async () => {
    for (const id of ["my.svc", "my-svc", "my_svc", "svc123"]) {
      const result = await validateManifest({ ...VALID, id });
      expect(result.valid, `id "${id}" should be valid`).toBe(true);
    }
  });
});

test.describe("validateManifest — missing required fields", () => {
  test("rejects a non-object manifest", async () => {
    const result = await validateManifest(null);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/not an object/);
  });

  test("rejects missing id", async () => {
    const { id, ...rest } = VALID;
    const result = await validateManifest(rest);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("manifest.id"))).toBe(true);
  });

  test("rejects missing name", async () => {
    const { name, ...rest } = VALID;
    const result = await validateManifest(rest);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("manifest.name"))).toBe(true);
  });

  test("rejects missing version", async () => {
    const { version, ...rest } = VALID;
    const result = await validateManifest(rest);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("manifest.version"))).toBe(true);
  });

  test("rejects missing entry", async () => {
    const { entry, ...rest } = VALID;
    const result = await validateManifest(rest);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("manifest.entry"))).toBe(true);
  });
});

test.describe("validateManifest — invalid id format", () => {
  test("rejects uppercase ids", async () => {
    const result = await validateManifest({ ...VALID, id: "MyService" });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("lowercase"))).toBe(true);
  });

  test("rejects ids with special characters", async () => {
    const result = await validateManifest({ ...VALID, id: "my service!" });
    expect(result.valid).toBe(false);
  });

  test("rejects an empty id", async () => {
    const result = await validateManifest({ ...VALID, id: "" });
    expect(result.valid).toBe(false);
  });
});

test.describe("validateManifest — invalid configSchema", () => {
  test("rejects configSchema that is not an object", async () => {
    const result = await validateManifest({ ...VALID, configSchema: "not-an-object" });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("configSchema"))).toBe(true);
  });

  test("rejects a null configSchema", async () => {
    const result = await validateManifest({ ...VALID, configSchema: null });
    expect(result.valid).toBe(false);
  });
});

test.describe("validateManifest — dependencies", () => {
  test("rejects a self-dependency", async () => {
    const result = await validateManifest({ ...VALID, dependencies: ["my-svc"] });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("self-dependencies"))).toBe(true);
  });

  test("accepts valid (non-self) dependencies", async () => {
    const result = await validateManifest({ ...VALID, dependencies: ["a", "b"] });
    expect(result.valid).toBe(true);
  });

  test("rejects a non-array dependencies field", async () => {
    const result = await validateManifest({ ...VALID, dependencies: "not-an-array" });
    expect(result.valid).toBe(false);
  });

  test("rejects a dependencies array with non-string entries", async () => {
    const result = await validateManifest({ ...VALID, dependencies: [123] });
    expect(result.valid).toBe(false);
  });
});

test.describe("validateManifest — entrypoint existence (itemDir supplied)", () => {
  test("passes when the entrypoint exists on disk", async () => {
    const dir = freshItemDir("entry-exists");
    writeFileSync(join(dir, "index.js"), "module.exports = {};");
    const result = await validateManifest(VALID, dir);
    expect(result.valid).toBe(true);
  });

  test("fails when the entrypoint does not exist on disk", async () => {
    const dir = freshItemDir("entry-missing");
    const result = await validateManifest(VALID, dir);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("does not exist"))).toBe(true);
  });
});

test.describe("validateManifestAtStart", () => {
  test("passes for a valid, loadable entrypoint", async () => {
    const dir = freshItemDir("at-start-valid");
    const serviceDir = join(dir, "services");
    mkdirSync(serviceDir, { recursive: true });
    writeFileSync(join(serviceDir, "index.js"), "module.exports = {};");
    // 035: the second argument is the service's OWN directory, not a root that
    // manifest.id is joined onto.
    const result = await validateManifestAtStart(VALID as unknown as { id: string; entry: string } & typeof VALID, serviceDir);
    expect(result.valid).toBe(true);
  });

  test("fails when the entrypoint does not exist", async () => {
    const dir = freshItemDir("at-start-missing");
    const result = await validateManifestAtStart(VALID as unknown as { id: string; entry: string } & typeof VALID, dir);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/entrypoint not found/);
  });

  test("an entrypoint that throws at load is invalid, and the throw never reaches this process", async () => {
    // HISTORY — this test asserted the OPPOSITE (`valid: true`, presence-only)
    // until it was found failing against the implementation it is supposed to
    // describe. Two fixes for the same outage (an item's `if (!parentPort)
    // process.exit(0)` killing the BOS server) were written independently:
    // presence-only, and an isolated load check in a throwaway child process.
    // The Sep 17 conflict-resolution merge (0a54d8035) took the child-process
    // implementation and its tests, but left this one and its neighbour behind
    // describing the abandoned design — the modify/delete leftovers AGENTS.md
    // §2 warns to expect after a `-X theirs` merge. They were never resolved,
    // so the suite has carried two red tests since.
    //
    // The surviving design keeps BOTH properties: a broken entrypoint is caught
    // before a worker is spun up, AND nothing an item does at load can touch
    // BOS's process. That is what this file now tests.
    const dir = freshItemDir("at-start-throws");
    const serviceDir = join(dir, "services");
    mkdirSync(serviceDir, { recursive: true });
    writeFileSync(join(serviceDir, "index.js"), "throw new Error('boom');");
    const result = await validateManifestAtStart(VALID as unknown as { id: string; entry: string } & typeof VALID, serviceDir);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/entrypoint failed to load/);
    // The cause is reported, not just the verdict — a "failed to load" with no
    // reason sends whoever debugs it to the wrong layer.
    expect(result.errors[0]).toMatch(/boom/);
  });
});

// Regression (follow-the-money preview outage): the load check used to
// `await import(entryPath)` IN the calling process, so an entry with a
// top-level side effect ran that side effect inside the BOS server. A worker
// entry guarding `!parentPort` with `process.exit(0)` exited the whole server
// (clean code 0, no error) during boot — the preview died on every start. The
// check must run item code only in a disposable child process. On the unfixed
// code the first test below kills the test worker itself.
test.describe("validateManifestAtStart — isolation from entry top-level side effects", () => {
  test("an entry that calls process.exit(0) when loaded outside a worker cannot kill the host, and validates", async () => {
    const dir = freshItemDir("at-start-exit0");
    const serviceDir = join(dir, "services");
    mkdirSync(serviceDir, { recursive: true });
    writeFileSync(
      join(serviceDir, "index.js"),
      'if (!require("node:worker_threads").parentPort) { process.exit(0); }\nmodule.exports = {};',
    );
    const result = await validateManifestAtStart(VALID as unknown as Parameters<typeof validateManifestAtStart>[0], serviceDir);
    // Exiting 0 mid-load still counts as loadable: the check's job is syntax/
    // deps, and the real run happens in a Worker where parentPort is set.
    expect(result.valid).toBe(true);
  });

  test("an entry that exits non-zero on load is invalid — and still cannot kill the host", async () => {
    const dir = freshItemDir("at-start-exit-nonzero");
    const serviceDir = join(dir, "services");
    mkdirSync(serviceDir, { recursive: true });
    writeFileSync(join(serviceDir, "index.js"), "process.exit(7);");
    const result = await validateManifestAtStart(VALID as unknown as Parameters<typeof validateManifestAtStart>[0], serviceDir);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/entrypoint failed to load/);
  });
});

test.describe("validateServiceJson", () => {
  test("parses and validates well-formed JSON", async () => {
    const result = await validateServiceJson(JSON.stringify(VALID));
    expect(result.valid).toBe(true);
  });

  test("rejects invalid JSON", async () => {
    const result = await validateServiceJson("{ not valid json");
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/invalid JSON/);
  });

  test("propagates structural validation errors for parsed-but-invalid manifests", async () => {
    const result = await validateServiceJson(JSON.stringify({ id: "BAD ID" }));
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

test.describe("validateManifestAtStart: an item's entrypoint cannot take BOS down", () => {
  // THE FAILURE. A preview build died 0.7s after "Ready in 272ms":
  //
  //   ✓ Ready in 272ms
  //   [bos-plugin:bmad] loaded …
  //   [supervisor] version "preview" server exited (code 0)
  //   [supervisor] bos/follow-the-money -> failed
  //     err: "health check failed: no healthy /api/health on :3001 within 120000ms"
  //
  // The app BOS had just built ships this at the top of its worker entry:
  //
  //   let parentPort = null;
  //   try { parentPort = require("node:worker_threads").parentPort; } catch {}
  //   if (!parentPort) { process.exit(0); }   // "when loaded on the main
  //                                           //  thread (the manifest's
  //                                           //  import() load check)"
  //
  // and this validator DID import it on the main thread, on the documented
  // assumption that "worker entrypoints only touch parentPort inside their
  // message handlers, so importing them from the main thread is safe". The
  // item's own comment cites the same CH-011 requirement: it wrote that guard
  // BECAUSE of this load check, and the guard is fatal here.
  //
  // The app's line is defensive and ordinary. What is not ordinary is that any
  // installed item can end the BrowserOS process with it — the check runs the
  // user's code in BOS's own thread. That is the defect under test.
  test("an entrypoint that exits when it is not a worker is never run here", async () => {
    const dir = freshItemDir("at-start-exits-on-main-thread");
    const serviceDir = join(dir, "services");
    mkdirSync(serviceDir, { recursive: true });
    writeFileSync(
      join(serviceDir, "index.js"),
      [
        'let parentPort = null;',
        'try { parentPort = require("node:worker_threads").parentPort; } catch { parentPort = null; }',
        'if (!parentPort) { process.exit(0); }',
        'parentPort.on("message", () => {});',
      ].join("\n"),
    );

    const result = await validateManifestAtStart(
      VALID as unknown as { id: string; entry: string } & typeof VALID,
      serviceDir,
    );

    // If this assertion is reached at all, the process survived — which is the
    // point. Before the fix this test does not fail, it DISAPPEARS: the worker
    // running it exits mid-test with "worker process exited unexpectedly
    // (code=0, signal=null)".
    expect(result.valid, `a worker-guarded entrypoint is valid: ${result.errors.join("; ")}`).toBe(true);
  });

  test("item code runs ONLY in the disposable child, never in this process", async () => {
    // The guarantee, stated as a property rather than as a list of cases.
    //
    // "Did it run?" is the wrong question — the load check has to run the entry
    // to learn anything about it. The question that actually protects BOS is
    // WHERE it ran, so the fixture records the pid that loaded it and the test
    // compares that against its own. An implementation that reintroduces an
    // in-process `await import(entryPath)` still writes the proof file, so an
    // existence check alone would keep passing; the pid comparison is what
    // fails, and it is the thing the outage turned on.
    const dir = freshItemDir("at-start-child-only");
    const serviceDir = join(dir, "services");
    mkdirSync(serviceDir, { recursive: true });
    const proof = join(serviceDir, "loaded-by.txt");
    writeFileSync(
      join(serviceDir, "index.js"),
      `require("fs").writeFileSync(${JSON.stringify(proof)}, String(process.pid));`,
    );
    const result = await validateManifestAtStart(
      VALID as unknown as { id: string; entry: string } & typeof VALID,
      serviceDir,
    );
    expect(result.valid).toBe(true);
    expect(existsSync(proof), "the load check must actually load the entry").toBe(true);
    expect(readFileSync(proof, "utf8"), "the entry must NOT have been loaded in this process").not.toBe(
      String(process.pid),
    );
  });
});
