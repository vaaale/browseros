import "server-only";

// Per-agent memory layout (023-per-agent-memory). Every agent gets its own
// isolated memory tree in the VFS:
//
//   /Memories/<agentId>/
//       MEMORY.md            — "# User preferences" + auto-generated "# Memory index"
//       Topics/<slug>.md     — topic-sharded long-term memory
//       Episodes/<date>-<conversationId>.md
//       Episodes/.Archive/   — consolidated episodes past the archive age
//       .watermarks.json     — per-conversation fast-loop review watermarks
//       .consolidate.lock    — slow-loop overlap lock
//
// agentId is the STABLE agent id (e.g. "assistant"), never the display name —
// it's validated to a filesystem-safe charset so it can be a path segment.

export const MEMORIES_ROOT = "/Memories";

const AGENT_ID_RE = /^[A-Za-z0-9._-]+$/;

/** Validate an agent id for use as a path segment. Throws on anything unsafe. */
export function safeAgentId(agentId: string): string {
  const id = (agentId ?? "").trim();
  if (!id) throw new Error("agentId is required for agent-scoped memory");
  if (!AGENT_ID_RE.test(id) || id.includes("..")) {
    throw new Error(`Invalid agentId "${agentId}" — expected [A-Za-z0-9._-] only`);
  }
  return id;
}

export function agentMemoryRoot(agentId: string): string {
  return `${MEMORIES_ROOT}/${safeAgentId(agentId)}`;
}

export function agentMemoryFile(agentId: string): string {
  return `${agentMemoryRoot(agentId)}/MEMORY.md`;
}

export function agentTopicsDir(agentId: string): string {
  return `${agentMemoryRoot(agentId)}/Topics`;
}

export function agentEpisodesDir(agentId: string): string {
  return `${agentMemoryRoot(agentId)}/Episodes`;
}

export function agentEpisodesArchiveDir(agentId: string): string {
  return `${agentEpisodesDir(agentId)}/.Archive`;
}

export function agentWatermarksFile(agentId: string): string {
  return `${agentMemoryRoot(agentId)}/.watermarks.json`;
}

export function agentLockFile(agentId: string): string {
  return `${agentMemoryRoot(agentId)}/.consolidate.lock`;
}
