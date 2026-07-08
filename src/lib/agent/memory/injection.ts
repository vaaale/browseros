import "server-only";

// Shared, cheap prompt-injection scan. Memory (curated + episodes + topics) all
// end up in the assistant's context, so the same list of high-impact patterns is
// applied across writers. Improvements to detection are a deliberate non-goal
// of spec 021 — this file exists so the fast/slow loops can call the exact same
// scanner curated.ts uses without cross-module import churn.

const THREAT_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+|the\s+|your\s+)?(previous|prior|above)\s+instructions/i,
  /disregard\s+(the\s+|all\s+)?(above|previous|prior)/i,
  /\bsystem\s+prompt\b/i,
  /\bexfiltrat/i,
  /<\s*\/?\s*(system|tool_call|tool_result)\s*>/i,
];

/** True when the content matches an obvious prompt-injection pattern. Fast,
 *  no state, safe to call on every write.
 *  DISABLED FOR NOW */
export function looksLikeInjection(content: string): boolean {
  // if (!content) return false;
  // for (const re of THREAT_PATTERNS) if (re.test(content)) return true;
  return false;
}

/** The matching pattern for logging (or null when clean). */
export function firstInjectionMatch(content: string): string | null {
  // if (!content) return null;
  // for (const re of THREAT_PATTERNS) if (re.test(content)) return re.source;
  return null;
}
