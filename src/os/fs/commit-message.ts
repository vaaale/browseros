// Pure commit-message helpers for SpecFS (027-vfs-specfs). No `server-only` —
// unit-testable. The deterministic message is always safe; an optional LLM
// message (wired via SpecFS.setCommitMessageFn) is bounded by boundDiff first.

const MAX_DIFF_BYTES = 12_000;
const MAX_DIFF_FILES = 50;

/** Bound a diff so a large coalesced flush cannot blow an LLM's context/cost. */
export function boundDiff(diff: string): string {
  return diff.length > MAX_DIFF_BYTES
    ? diff.slice(0, MAX_DIFF_BYTES) + "\n…[diff truncated]"
    : diff;
}

/** Deterministic commit message derived from a unified diff: the changed file
 *  list, capped. Used as the always-available fallback. */
export function deterministicMessage(diff: string): string {
  const files = Array.from(diff.matchAll(/^\+\+\+ b\/(.+)$/gm)).map((m) => m[1]);
  const unique = Array.from(new Set(files)).slice(0, MAX_DIFF_FILES);
  if (unique.length === 0) return "spec: update";
  if (unique.length === 1) return `spec: update ${unique[0]}`;
  return `spec: update ${unique.length} files (${unique[0]}, …)`;
}
