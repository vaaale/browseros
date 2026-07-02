// Pure, framework-free helpers for developer feature branches. Usable from both
// client (elicitation card, selector) and server (delegate route, workflow
// runner). A feature branch is `bos/<kebab-name>` with one to four lowercase
// dash-separated segments (specs/005-self-modification FR-003).

export const FEATURE_BRANCH_RE = /^bos\/[a-z0-9]+(?:-[a-z0-9]+){0,3}$/;

export function isValidFeatureBranch(branch: string): boolean {
  return FEATURE_BRANCH_RE.test(branch.trim());
}

// Words that add no meaning to a branch name — dropped when deriving a slug.
const STOPWORDS = new Set([
  "a", "an", "the", "to", "of", "for", "and", "or", "in", "on", "with", "into",
  "please", "can", "you", "we", "i", "it", "this", "that", "make", "let", "lets",
  "add", "create", "build", "implement", "turn", "convert", "system", "component",
]);

/** Slugify arbitrary text into up to four lowercase dash-separated segments. */
function slugSegments(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]+/g, " ")
    .split(/[\s-]+/)
    .filter(Boolean);
}

/**
 * Normalize a user-supplied name into a valid `bos/<kebab-name>` branch, or
 * return null when nothing usable remains. Strips an existing `bos/` prefix,
 * slugifies, and clamps to four segments.
 */
export function normalizeFeatureBranch(name: string): string | null {
  const withoutPrefix = name.trim().replace(/^bos\//i, "");
  const segments = slugSegments(withoutPrefix).slice(0, 4);
  if (segments.length === 0) return null;
  const branch = `bos/${segments.join("-")}`;
  return isValidFeatureBranch(branch) ? branch : null;
}

/**
 * Derive a suggested `bos/<kebab-name>` branch from a task description. Drops
 * stopwords, keeps the first few meaningful words, and always returns a valid
 * branch (falls back to `bos/change`).
 */
export function suggestFeatureBranchName(task: string): string {
  const meaningful = slugSegments(task).filter((w) => !STOPWORDS.has(w));
  const picked = (meaningful.length > 0 ? meaningful : slugSegments(task)).slice(0, 4);
  return normalizeFeatureBranch(picked.join("-")) ?? "bos/change";
}
