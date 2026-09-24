import "server-only";
import type { AgentRunUsage } from "@/lib/agent/subagents/types";
import { appendCostLedger, getCostLedger } from "./store";
import { readSelfHealConfig } from "./config";
import type { CostLedgerEntry } from "./types";

// The self-heal cost ledger (031-self-healing FR-020, design ADR-5).
//
// The cap is enforced BETWEEN cases, not within one. A case already in flight
// runs to completion and is recorded as one ledger entry at its end — which is
// exactly FR-020's stated semantics ("cost cap reached mid-pipeline: the
// pipeline completes its current case; NEW triggers are queued for the next
// day"). A single very large case can therefore overshoot the daily cap; that
// is a deliberate, documented trade, not an oversight.
//
// The primary input is REAL provider-reported usage, surfaced by ADR-5's
// TurnResult/AgentRunResult extension. The estimate below is only for providers
// that report nothing (some local inference servers) — and it marks its entries
// `estimated: true` so the ledger stays honest about what it knows.

/** The UTC day an epoch-ms timestamp belongs to (`YYYY-MM-DD`). The cap resets
 *  at midnight UTC (FR-020) — deliberately not local midnight, so the reset
 *  point doesn't move with the user's timezone or DST. */
export function getDayKey(at: number = Date.now()): string {
  return new Date(at).toISOString().slice(0, 10);
}

/** Roughly 4 characters per token — the same coarse heuristic the compaction
 *  estimator uses. Only reached when a provider reports no usage at all. */
export function estimateTokens(...texts: (string | undefined)[]): number {
  const chars = texts.reduce((sum, t) => sum + (t?.length ?? 0), 0);
  return Math.max(1, Math.ceil(chars / 4));
}

/** Total tokens for one run: the provider's number when it gave one, otherwise
 *  a marked estimate from the prompt + output text. */
export function tokensForRun(
  usage: AgentRunUsage | undefined,
  fallbackTexts: (string | undefined)[],
): { tokens: number; estimated: boolean } {
  if (usage && Number.isFinite(usage.totalTokens) && usage.totalTokens > 0) {
    return { tokens: usage.totalTokens, estimated: false };
  }
  return { tokens: estimateTokens(...fallbackTexts), estimated: true };
}

export async function recordCaseCost(
  caseId: string,
  role: CostLedgerEntry["role"],
  usage: AgentRunUsage | undefined,
  fallbackTexts: (string | undefined)[] = [],
): Promise<CostLedgerEntry> {
  const { tokens, estimated } = tokensForRun(usage, fallbackTexts);
  const entry: CostLedgerEntry = { caseId, role, tokens, at: Date.now(), ...(estimated ? { estimated: true } : {}) };
  await appendCostLedger(entry);
  return entry;
}

/** Tokens spent today (UTC). Entries from earlier days are simply ignored at
 *  read time rather than pruned — the ledger doubles as a short audit trail,
 *  and `pruneLedger` handles growth separately. */
export async function tokensSpentToday(at: number = Date.now()): Promise<number> {
  const day = getDayKey(at);
  const ledger = await getCostLedger();
  return ledger.filter((e) => getDayKey(e.at) === day).reduce((sum, e) => sum + (e.tokens || 0), 0);
}

/** True when today's spend has reached the configured cap. A cap of 0 means
 *  "no cap" rather than "block everything" — a zero would otherwise silently
 *  disable the whole mechanism through a limits field. */
export async function capExhaustedForToday(at: number = Date.now()): Promise<boolean> {
  const cfg = await readSelfHealConfig();
  if (!cfg.costCapPerDay || cfg.costCapPerDay <= 0) return false;
  return (await tokensSpentToday(at)) >= cfg.costCapPerDay;
}

export interface CostStatus {
  spentToday: number;
  capPerDay: number;
  exhausted: boolean;
  day: string;
}

/** What the Settings tab and the BS pane show. */
export async function costStatus(at: number = Date.now()): Promise<CostStatus> {
  const cfg = await readSelfHealConfig();
  const spentToday = await tokensSpentToday(at);
  return {
    spentToday,
    capPerDay: cfg.costCapPerDay,
    exhausted: cfg.costCapPerDay > 0 && spentToday >= cfg.costCapPerDay,
    day: getDayKey(at),
  };
}
