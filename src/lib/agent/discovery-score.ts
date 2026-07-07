// Deterministic scoring for the runtime tool/agent discovery tools
// (025-deferred-tool-discovery). Framework-free (no server-only, no react) so
// it can be unit-tested in isolation and reused from either surface.

import type { Capability } from "./capabilities-registry";

function normalize(s: string): string {
  return (s ?? "").toLowerCase().trim();
}

function words(s: string): string[] {
  return normalize(s).split(/[^a-z0-9]+/).filter((w) => w.length > 1);
}

function includes(haystack: string, needle: string): boolean {
  return normalize(haystack).includes(normalize(needle));
}

function hasWordMatch(id: string, query: string): boolean {
  const idWords = new Set(id.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  for (const w of words(query)) if (idWords.has(w)) return true;
  return false;
}

/**
 * Score a capability against a free-text query. Higher = better match.
 * Zero score means "not a match at all" and should be dropped from results.
 *
 * The scheme is intentionally simple (spec: substring/score, no embeddings):
 *   + 5 : any query word matches an id word (e.g. "read" ↔ "file_read")
 *   + 3 : query is a substring of the capability id
 *   + 2 : query is a substring of the description
 *   + 2 : query is a substring of the group name
 *   + 1 : query is a substring of the group description (semantic expansion —
 *         propagates matches to every deferred tool in the same group)
 */
export function scoreCapability(cap: Capability, query: string, groupDesc: string): number {
  const q = normalize(query);
  if (!q) return 0;
  let score = 0;
  if (hasWordMatch(cap.id, q)) score += 5;
  if (includes(cap.id, q)) score += 3;
  if (includes(cap.description, q)) score += 2;
  if (includes(cap.group, q)) score += 2;
  if (includes(groupDesc, q)) score += 1;
  return score;
}

/**
 * Score an agent's identity metadata against a query. Only name/description/type
 * participate — tool composition is deliberately opaque (spec clarification 1).
 */
export function scoreAgent(
  agent: { name: string; description: string; type: string },
  query: string,
): number {
  const q = normalize(query);
  if (!q) return 0;
  let score = 0;
  if (hasWordMatch(agent.name, q)) score += 5;
  if (includes(agent.name, q)) score += 3;
  if (includes(agent.description, q)) score += 2;
  if (includes(agent.type, q)) score += 1;
  return score;
}
