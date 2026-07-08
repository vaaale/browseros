import "server-only";

// Per-agent capability scoping (spec: 011-per-agent-capabilities). An agent may
// carry allowlists for tools, skills, and MCP servers. The invariant everywhere:
// an UNSET or EMPTY allowlist means "all" (back-compatible), and a non-empty list
// permits ONLY the listed ids.

export function isAllowed(allow: string[] | undefined, ...ids: string[]): boolean {
  if (!allow || allow.length === 0) return true;
  return ids.some((id) => allow.includes(id));
}

export function filterAllowed<T>(allow: string[] | undefined, items: T[], idOf: (t: T) => string): T[] {
  if (!allow || allow.length === 0) return items;
  const set = new Set(allow);
  return items.filter((t) => set.has(idOf(t)));
}
