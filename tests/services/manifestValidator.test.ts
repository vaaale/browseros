// manifestValidator: validateManifest / validateServiceJson / validateManifestAtStart
//   npx playwright test -c playwright.unit.config.ts tests/services/manifestValidator.test.ts
import "./_stub-server-only";
import { test, expect } from "@playwright/test";
import { join } from "path";
import { mkdirSync, writeFileSync, rmSync } from "fs";
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
    const result = await validateManifestAtStart(VALID as any, dir);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/entrypoint not found/);
  });

  test("fails when the entrypoint throws on load", async () => {
    const dir = freshItemDir("at-start-throws");
    const serviceDir = join(dir, "services");
    mkdirSync(serviceDir, { recursive: true });
    writeFileSync(join(serviceDir, "index.js"), "throw new Error('boom');");
    const result = await validateManifestAtStart(VALID as any, serviceDir);
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
