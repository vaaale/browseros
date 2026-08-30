import "server-only";

// Shared line-matching used by repo-fs.ts and spec-fs.ts's search(). Agents
// tend to pass natural-language "keywords" (e.g. "promote blocked") rather
// than a single literal string; matching the whole query as one substring
// almost never hits since the words are rarely adjacent verbatim in source.
// Splitting on whitespace and requiring every term to appear somewhere in the
// line (any order) fixes that while still matching an exact adjacent phrase
// as a special case (all its words are present too).

export function searchTerms(query: string, caseSensitive?: boolean): string[] {
  const q = caseSensitive ? query : query.toLowerCase();
  return q.split(/\s+/).filter(Boolean);
}

export function lineMatchesTerms(line: string, terms: string[], caseSensitive?: boolean): boolean {
  const hay = caseSensitive ? line : line.toLowerCase();
  return terms.every((t) => hay.includes(t));
}
