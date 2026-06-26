import "server-only";
import { listSkills, archiveSkill } from "./store";
import { allUsage } from "./usage";

// The Curator (spec/self-improvement.md §5): maintains the agent-created skill
// library. Deterministic, non-destructive — it only ARCHIVES (recoverable),
// only touches agent-created, unpinned skills, and leaves a skill alone until it
// has been idle past the staleness threshold.
//
// BOS has no background daemon, so this runs on demand (an assistant action /
// API route). It can be scheduled externally later.

const DAY = 86_400_000;
const DEFAULT_STALE_AFTER_DAYS = 45;

export interface CuratorResult {
  reviewed: number;
  archived: string[];
  skipped: { pinned: number; protected: number; active: number };
}

export async function runCurator(opts?: { staleAfterDays?: number }): Promise<CuratorResult> {
  const staleMs = (opts?.staleAfterDays ?? DEFAULT_STALE_AFTER_DAYS) * DAY;
  const [skills, usage] = await Promise.all([listSkills(), allUsage()]);
  const now = Date.now();
  const archived: string[] = [];
  const skipped = { pinned: 0, protected: 0, active: 0 };

  for (const s of skills) {
    if (s.createdBy !== "agent") {
      skipped.protected += 1; // seeded/built-in skills are off-limits
      continue;
    }
    if (s.pinned) {
      skipped.pinned += 1;
      continue;
    }
    const last = usage[s.id]?.lastActivityAt ?? 0;
    if (!last || now - last <= staleMs) {
      skipped.active += 1; // no activity record (treat as fresh) or still within window
      continue;
    }
    if (await archiveSkill(s.id)) archived.push(s.id);
  }

  return { reviewed: skills.length, archived, skipped };
}
