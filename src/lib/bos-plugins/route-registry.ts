import type { RouteMethod, RouteHandler, RouteRegistration } from "./types";

const KEY = "__bos_plugin_routes__" as const;

function getRegistry(): Map<string, RouteRegistration[]> {
  const g = globalThis as Record<string, unknown>;
  if (!g[KEY]) g[KEY] = new Map<string, RouteRegistration[]>();
  return g[KEY] as Map<string, RouteRegistration[]>;
}

export function registerRoute(
  pluginId: string,
  method: RouteMethod,
  path: string,
  handler: RouteHandler,
): void {
  const reg = getRegistry();
  const normalized = path.startsWith("/") ? path : `/${path}`;
  const entries = reg.get(pluginId) ?? [];
  entries.push({ method, path: normalized, handler });
  reg.set(pluginId, entries);
}

export function unregisterRoutes(pluginId: string): void {
  getRegistry().delete(pluginId);
}

export function matchRoute(
  pluginId: string,
  method: string,
  path: string,
): RouteHandler | undefined {
  const entries = getRegistry().get(pluginId);
  if (!entries) return undefined;
  const normalized = path.startsWith("/") ? path : `/${path}`;
  const entry = entries.find(
    (e) => e.method === method.toUpperCase() && e.path === normalized,
  );
  return entry?.handler;
}

export function isPluginRegistered(pluginId: string): boolean {
  return getRegistry().has(pluginId);
}
