// Files BOS writes INSIDE an asset directory (`data/agents/<id>/`,
// `data/skills/<id>/`) that are BOS's bookkeeping ABOUT the asset, not part of
// the asset.
//
// One list, in one place, because two subsystems have to agree on it:
//
//   - the agent/skill stores WRITE these (seed revisions, one-time migration
//     markers), so a migration runs exactly once per install;
//   - bundled-asset seeding HASHES an asset directory to decide whether the
//     user edited an installed agent/skill, and must therefore EXCLUDE them.
//
// When those two disagreed, BOS's own migration marker counted as a user edit:
// `backfillLegacyAllowlists()` writes `.capabilities-migrated` into every
// directory under `data/agents/`, including agents installed from a marketplace
// item — so the next reconciliation pass saw a changed directory and reported
// "this agent was edited since it was installed" on an agent nobody had
// touched. Accepting the update deleted the marker, the next boot rewrote it,
// and the prompt returned forever.
//
// A new marker MUST be added here, not declared privately beside the code that
// writes it. `tests/services/bundled-assets.test.ts` runs the real agent store's
// migrations over an installed bundled agent and asserts no conflict is raised,
// so a marker that skips this list fails there rather than in a user's Settings.

/** Records which item an asset was installed from, and what was installed. */
export const PROVENANCE_FILE = ".installed-from.json";

/** Which revision of BOS's own seed produced this copy (agent + skill stores). */
export const SEED_REV_FILE = ".seed-rev";

/** One-time migration markers, each guarding a backfill in subagents/store.ts. */
export const CAPABILITIES_MIGRATED_MARKER = ".capabilities-migrated";
export const CONFLICT_TOOLS_BACKFILL_MARKER = ".conflict-tools-backfilled";
export const SELF_HEAL_TOOLS_BACKFILL_MARKER = ".self-heal-tools-backfilled";
export const BROWSER_TOOLS_BACKFILL_MARKER = ".browser-tools-backfilled";

export const ASSET_BOOKKEEPING_FILES: readonly string[] = [
  PROVENANCE_FILE,
  SEED_REV_FILE,
  CAPABILITIES_MIGRATED_MARKER,
  CONFLICT_TOOLS_BACKFILL_MARKER,
  SELF_HEAL_TOOLS_BACKFILL_MARKER,
  BROWSER_TOOLS_BACKFILL_MARKER,
];

/**
 * Is this filename BOS's bookkeeping rather than asset content?
 *
 * Matched by NAME at any depth, like the provenance exclusion it generalises.
 * Deliberately an explicit list and not "any dotfile": an item may legitimately
 * ship a `.gitignore` or `.env.example` inside a skill, and silently excluding
 * those would let an update overwrite a file the user had edited — the precise
 * failure the content hash exists to prevent.
 */
export function isAssetBookkeeping(fileName: string): boolean {
  return ASSET_BOOKKEEPING_FILES.includes(fileName);
}
