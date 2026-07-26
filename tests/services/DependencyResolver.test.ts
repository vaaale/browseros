// DependencyResolver: resolveOrder / detectCircular / detectMissing / checkDependenciesRunning
//   npx playwright test -c playwright.unit.config.ts tests/services/DependencyResolver.test.ts
import "./_stub-server-only";
import { test, expect } from "@playwright/test";
import {
  resolveOrder,
  detectCircular,
  detectMissing,
  checkDependenciesRunning,
} from "../../src/core/service/DependencyResolver";
import { ServiceRegistry } from "../../src/core/service/ServiceRegistry";
import type { ServiceManifest, ServiceDefinition } from "../../src/core/service/types";

function manifest(id: string, dependencies?: string[]): ServiceManifest {
  return { id, name: id, version: "1.0.0", entry: "index.js", ...(dependencies ? { dependencies } : {}) };
}

test.describe("resolveOrder", () => {
  test("orders a simple linear chain (A → B → C) so dependencies start first", () => {
    const a = manifest("a", ["b"]);
    const b = manifest("b", ["c"]);
    const c = manifest("c");
    const order = resolveOrder([a, b, c]).map((m) => m.id);
    expect(order.indexOf("c")).toBeLessThan(order.indexOf("b"));
    expect(order.indexOf("b")).toBeLessThan(order.indexOf("a"));
  });

  test("orders parallel dependencies (A depends on B and C; B/C independent)", () => {
    const a = manifest("a", ["b", "c"]);
    const b = manifest("b");
    const c = manifest("c");
    const order = resolveOrder([a, b, c]).map((m) => m.id);
    expect(order.indexOf("b")).toBeLessThan(order.indexOf("a"));
    expect(order.indexOf("c")).toBeLessThan(order.indexOf("a"));
  });

  test("handles no dependencies at all — order is stable, all present", () => {
    const services = [manifest("a"), manifest("b"), manifest("c")];
    const order = resolveOrder(services).map((m) => m.id);
    expect(new Set(order)).toEqual(new Set(["a", "b", "c"]));
  });

  test("does not crash on a circular dependency (A → B → A); cycle members are appended, not dropped", () => {
    const a = manifest("a", ["b"]);
    const b = manifest("b", ["a"]);
    const order = resolveOrder([a, b]);
    expect(order.map((m) => m.id).sort()).toEqual(["a", "b"]);
  });

  test("does not crash on a missing dependency (A depends on B, B absent) — A still included", () => {
    const a = manifest("a", ["missing-b"]);
    const order = resolveOrder([a]);
    expect(order.map((m) => m.id)).toEqual(["a"]);
  });
});

test.describe("detectCircular", () => {
  test("returns the cycle for circular dependencies", () => {
    const a = manifest("a", ["b"]);
    const b = manifest("b", ["a"]);
    const cycles = detectCircular([a, b]);
    expect(cycles.length).toBeGreaterThan(0);
    expect(cycles[0]).toContain("a");
    expect(cycles[0]).toContain("b");
  });

  test("returns no cycles for an acyclic graph", () => {
    const a = manifest("a", ["b"]);
    const b = manifest("b");
    expect(detectCircular([a, b])).toEqual([]);
  });
});

test.describe("detectMissing", () => {
  test("returns missing dependency ids keyed by service id", () => {
    const a = manifest("a", ["absent"]);
    const b = manifest("b");
    const missing = detectMissing([a, b]);
    expect(missing).toEqual({ a: ["absent"] });
  });

  test("returns an empty object when every dependency is present", () => {
    const a = manifest("a", ["b"]);
    const b = manifest("b");
    expect(detectMissing([a, b])).toEqual({});
  });
});

test.describe("checkDependenciesRunning", () => {
  function registryWith(defs: Array<{ id: string; state: ServiceDefinition["state"]; dependencies?: string[] }>): ServiceRegistry {
    const registry = new ServiceRegistry();
    for (const d of defs) {
      registry.registerInstalled(d.id, manifest(d.id, d.dependencies), `/items/${d.id}`);
      registry.setState(d.id, d.state);
    }
    return registry;
  }

  test("returns true when every dependency is running", () => {
    const registry = registryWith([
      { id: "b", state: "running" },
      { id: "c", state: "running" },
      { id: "a", state: "stopped", dependencies: ["b", "c"] },
    ]);
    expect(checkDependenciesRunning("a", registry)).toBe(true);
  });

  test("returns false when one dependency is not running", () => {
    const registry = registryWith([
      { id: "b", state: "running" },
      { id: "c", state: "stopped" },
      { id: "a", state: "stopped", dependencies: ["b", "c"] },
    ]);
    expect(checkDependenciesRunning("a", registry)).toBe(false);
  });

  test("returns true when the service declares no dependencies", () => {
    const registry = registryWith([{ id: "a", state: "stopped" }]);
    expect(checkDependenciesRunning("a", registry)).toBe(true);
  });

  test("treats a missing (never-installed) dependency as not running", () => {
    const registry = registryWith([{ id: "a", state: "stopped", dependencies: ["never-installed"] }]);
    expect(checkDependenciesRunning("a", registry)).toBe(false);
  });
});
