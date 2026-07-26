import "server-only";
import { logger } from "@/lib/logging";
import type { ServiceManifest } from "./types";
import type { ServiceRegistry } from "./ServiceRegistry";

const COMPONENT = "services.dependencies";

/** Log a warning (does NOT prevent startup) for any circular dependency chains. */
export function detectCircular(manifests: ServiceManifest[]): string[][] {
  const byId = new Map(manifests.map((m) => [m.id, m]));
  const cycles: string[][] = [];
  const state = new Map<string, "visiting" | "done">();

  function visit(id: string, stack: string[]): void {
    if (state.get(id) === "done") return;
    if (state.get(id) === "visiting") {
      const cycleStart = stack.indexOf(id);
      cycles.push(stack.slice(cycleStart).concat(id));
      return;
    }
    state.set(id, "visiting");
    const manifest = byId.get(id);
    for (const dep of manifest?.dependencies ?? []) {
      if (byId.has(dep)) visit(dep, [...stack, id]);
    }
    state.set(id, "done");
  }

  for (const m of manifests) visit(m.id, []);

  if (cycles.length > 0) {
    for (const cycle of cycles) {
      logger().warn(COMPONENT, "circular dependency detected — startup order for these services is not guaranteed", {
        cycle,
      });
    }
  }
  return cycles;
}

/** Log a warning (does NOT prevent startup) for dependency ids not found among installed services. */
export function detectMissing(manifests: ServiceManifest[]): Record<string, string[]> {
  const ids = new Set(manifests.map((m) => m.id));
  const missing: Record<string, string[]> = {};
  for (const m of manifests) {
    const absent = (m.dependencies ?? []).filter((dep) => !ids.has(dep));
    if (absent.length > 0) {
      missing[m.id] = absent;
      logger().warn(COMPONENT, `service "${m.id}" declares missing dependencies: ${absent.join(", ")}`, {
        id: m.id,
        missing: absent,
      });
    }
  }
  return missing;
}

/**
 * Topological sort (Kahn's algorithm) over the dependency graph. Services with
 * circular dependencies are NOT excluded — they're appended at the end (in
 * their original order) after a warning is logged, so startup always makes
 * progress instead of stalling on an unresolved cycle.
 */
export function resolveOrder(manifests: ServiceManifest[]): ServiceManifest[] {
  detectCircular(manifests);
  detectMissing(manifests);

  const byId = new Map(manifests.map((m) => [m.id, m]));
  const inDegree = new Map<string, number>(manifests.map((m) => [m.id, 0]));
  for (const m of manifests) {
    for (const dep of m.dependencies ?? []) {
      if (byId.has(dep)) inDegree.set(m.id, (inDegree.get(m.id) ?? 0) + 1);
    }
  }

  const queue = manifests.filter((m) => (inDegree.get(m.id) ?? 0) === 0).map((m) => m.id);
  const ordered: ServiceManifest[] = [];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const manifest = byId.get(id);
    if (manifest) ordered.push(manifest);
    for (const m of manifests) {
      if ((m.dependencies ?? []).includes(id) && !visited.has(m.id)) {
        const remaining = (inDegree.get(m.id) ?? 0) - 1;
        inDegree.set(m.id, remaining);
        if (remaining <= 0) queue.push(m.id);
      }
    }
  }

  // Anything left unvisited is part of a cycle — append in original order.
  for (const m of manifests) {
    if (!visited.has(m.id)) ordered.push(m);
  }

  return ordered;
}

/** CH-003 — crash-loop prevention: a dependent service only starts once every
 *  declared dependency is actually in the "running" state. A missing (never
 *  installed) dependency counts as "not running". */
export function checkDependenciesRunning(serviceId: string, registry: ServiceRegistry): boolean {
  const def = registry.getService(serviceId);
  const deps = def?.manifest.dependencies ?? [];
  if (deps.length === 0) return true;
  return deps.every((depId) => registry.getService(depId)?.state === "running");
}
