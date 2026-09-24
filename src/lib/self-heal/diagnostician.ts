import "server-only";
import * as vfs from "@/os/vfs";
import { logger } from "@/lib/logging";
import { getCase, updateCase } from "./store";
import { readSelfHealConfig } from "./config";
import { recordCaseCost } from "./cost";
import { markSelfHealConversation } from "./reentrancy";
import { casePayload, emitSelfHeal, summaryFor, SELF_HEAL_LOG } from "./events";
import { createRunObserver } from "./runs";
import {
  parseDiagnosticsReport,
  renderDiagnosticsReport,
  reportPathFor,
  REPORTS_DIR,
  type DiagnosticsFrontmatter,
} from "./report";
import { SELF_HEAL_EVENTS, humanCaseId, type HealingCase, type ScopeClass } from "./types";
import type { Agent, AgentRunResult, SubAgentEvent } from "@/lib/agent/subagents/types";
import type { ChatMessage } from "@/lib/assistant/messages";

// The Diagnostician (031-self-healing FR-007/FR-008, design ADR-2).
//
// It is the EXISTING `conversation-reviewer` agent, run headless in Mode 2:
// input is a failure signature, output is a markdown diagnostics report plus a
// scope-class verdict. Mode 1 (behavioral review of a past conversation) is
// unchanged and shares the same definition, tool set and skill; the mode is
// selected by the input type.
//
// This module owns three things and nothing else:
//   1. building the Mode-2 prompt (including the ownership facts the agent
//      cannot see for itself — see `ownershipFacts`),
//   2. launching the run through `runSubAgent` and billing it to the case,
//   3. turning whatever came back into a validated report on disk.
//
// Routing on the result is intake.ts's job (Phase B). Keeping the split means
// the LLM step has exactly one output contract and the deterministic router has
// exactly one input contract.

const DIAGNOSTICIAN_AGENT_ID = "conversation-reviewer";

/** Runtime `import()` for the agent layer, deliberately not a top-level import:
 *  `assistantTools()` composes the self-heal tools, which import this module —
 *  a static import here would be a real cycle. Same pattern as
 *  src/lib/scheduler/executor.ts. */
type AgentLayer = {
  getAgent: (id: string) => Promise<Agent | undefined>;
  runSubAgent: (
    agent: Agent,
    task: string,
    opts?: {
      conversationId?: string;
      contentOnly?: boolean;
      /** The run observer's sink (scope-add, ADR-12) — the Diagnostician seam
       *  the spine now passes, so its run is recorded on the case, transcribed
       *  with the case id, and watched by the stuck detector. */
      onEvent?: (event: SubAgentEvent) => void;
    },
  ) => Promise<AgentRunResult>;
  saveConversationMessages: (conversationId: string, agentId: string, messages: ChatMessage[]) => Promise<void>;
};

async function realAgentLayer(): Promise<AgentLayer> {
  const [{ getAgent }, { runSubAgent }, { saveConversationMessages }] = await Promise.all([
    import("@/lib/agent/subagents/store"),
    import("@/lib/agent/subagents/runner"),
    import("@/lib/assistant/conversation-store"),
  ]);
  return { getAgent, runSubAgent, saveConversationMessages };
}

let agentLayerImpl: () => Promise<AgentLayer> = realAgentLayer;

function agentLayer(): Promise<AgentLayer> {
  return agentLayerImpl();
}

/** Tests only: substitute the agent layer so the Diagnostician's post-run
 *  handling — a missing agent, a failed run, the tool-wrote-the-report happy
 *  path, and the prose fallback — is exercisable without a provider. `null`
 *  restores the real one. */
export function _setAgentLayerForTests(override: Partial<AgentLayer> | null): void {
  if (!override) {
    agentLayerImpl = realAgentLayer;
    return;
  }
  agentLayerImpl = async () => ({ ...(await realAgentLayer()), ...override });
}

export function diagnosticianConversationId(caseId: string): string {
  return `c-self-heal-diag-${caseId}`;
}

// ── Ownership facts (FR-012/FR-013, design §5's d/d-bis predicate) ──────────

export interface OwnershipFact {
  id: string;
  origin: "local" | "marketplace";
  marketplaceId?: string;
  installed: boolean;
  facets: string[];
}

/**
 * The AUTHORITATIVE d-vs-d-bis input, resolved server-side.
 *
 * The Diagnostician's `app_list` tool does not expose an item's provenance, and
 * a headless run cannot execute frontend tools at all — so the ownership
 * predicate is computed here and handed to the agent as fact, and confirmed
 * again by intake.ts before routing. `origin === "local"` means the
 * `data/system/<id>` symlink resolves into `data/user-apps/items/<id>`, i.e.
 * the user owns it and it is fixable (`d-bis`); `marketplace` means notify-only
 * (`d`). Cited home: src/system/items/installed.ts.
 */
export async function ownershipFacts(): Promise<OwnershipFact[]> {
  try {
    const { listInstalledItems } = await import("@/system/items/installed");
    const items = await listInstalledItems();
    return items.map((item) => ({
      id: item.id,
      origin: item.origin,
      ...(item.marketplaceId ? { marketplaceId: item.marketplaceId } : {}),
      installed: !item.broken,
      facets: Object.entries(item.facets)
        .filter(([, present]) => present)
        .map(([name]) => name),
    }));
  } catch (err) {
    logger().warn(SELF_HEAL_LOG, "ownership facts unavailable", { error: (err as Error)?.message ?? String(err) });
    return [];
  }
}

/** The user-owned (`d-bis`) item a surface description points at, if any. */
export function ownedItemFor(facts: OwnershipFact[], ...hints: (string | undefined)[]): OwnershipFact | undefined {
  const haystack = hints.filter(Boolean).join(" ").toLowerCase();
  if (!haystack) return undefined;
  return facts.find((f) => f.origin === "local" && haystack.includes(f.id.toLowerCase()));
}

// ── The Mode-2 prompt ───────────────────────────────────────────────────────

function contextLines(record: HealingCase): string[] {
  const c = record.context;
  const lines: string[] = [];
  const add = (label: string, value: unknown) => {
    if (value === undefined || value === null || value === "") return;
    lines.push(`- **${label}**: ${typeof value === "string" ? value : JSON.stringify(value)}`);
  };
  add("trigger", record.trigger);
  add("tool", c.toolName);
  add("error message", c.errorMessage);
  add("error code", c.errorCode);
  add("HTTP status", c.httpStatus);
  add("error category (deterministic bucket)", record.signature.errorCategory);
  add("dedupe key", record.signature.dedupeKey);
  add("reported description", c.description);
  add("conversation", c.conversationId);
  add("event", c.eventId);
  add("file path", c.filePath);
  add("app id", c.appId);
  add("log component", c.component);
  if (c.workflow) add("workflow", c.workflow);
  if (c.repeated) add("repeated failure", `${c.repeated.count} consecutive failures within ${c.repeated.windowSec}s`);
  if (c.extra && Object.keys(c.extra).length) add("extra", c.extra);
  return lines;
}

export function buildDiagnosticianPrompt(record: HealingCase, facts: OwnershipFact[]): string {
  const owned = facts.filter((f) => f.origin === "local").map((f) => f.id);
  const notOwned = facts.filter((f) => f.origin !== "local").map((f) => f.id);
  return [
    `# Mode 2 — Gap diagnosis for self-heal case ${humanCaseId(record.id)}`,
    "",
    "You are running in **Mode 2**: the input is a FAILURE SIGNATURE, not a conversationId.",
    "Do not call `conversation_overview`/`conversation_page` unless a conversation id is listed",
    "below; there is no transcript to page through otherwise. Follow the",
    "`agent-behavior-review` skill's \"Mode 2: Gap Diagnosis\" section for the method.",
    "",
    "## Failure signature",
    "",
    `- **case id**: ${record.id}`,
    `- **title**: ${record.title}`,
    ...contextLines(record),
    "",
    "## Ownership facts (authoritative — do not re-derive)",
    "",
    "The d-vs-d-bis predicate is resolved server-side and given to you as fact;",
    "`app_list` cannot see an item's provenance.",
    "",
    `- **user-owned items (class \`d-bis\`, fixable)**: ${owned.length ? owned.join(", ") : "(none)"}`,
    `- **marketplace items not owned by the user (class \`d\`, notify only)**: ${notOwned.length ? notOwned.join(", ") : "(none)"}`,
    "",
    "## What you must do",
    "",
    "1. Investigate the signature in BOS's actual source with `bos_source_search` /",
    "   `bos_source_read` / `bos_source_list`. Every claim you make about BOS's current",
    "   behavior needs a citation — a `path/to/file.ts:LINE` reference or a spec reference.",
    "   Do not assert a mechanism exists without reading it.",
    "2. Decide whether this is a **genuine gap** (name the exact missing surface) or a",
    "   **usage/agent error** (give the correct invocation).",
    "3. Classify the scope into exactly one class:",
    "   - `a` env — transient/external; no durable change. ownership `env`.",
    "   - `b` skill — the agent misused a working tool because a skill or memory",
    "     mis-teaches it. ownership `bos-core`. proposedSurface = the skill id.",
    "   - `c` workflow — a workflow definition or its data is wrong. ownership `workflow`.",
    "     proposedSurface = the `/Workflows/<id>.json` path.",
    "   - `d` app-not-owned — a marketplace app bug with no local copy. ownership",
    "     `marketplace`. proposedSurface = the app id. Notify only; never propose a fix.",
    "   - `d-bis` app-owned — a bug in an item listed as user-owned above. ownership",
    "     `user-app`. proposedSurface = the item id + the file inside it.",
    "   - `e` bos-core — a genuine gap in BOS's own source. ownership `bos-core`.",
    "     proposedSurface = the exact file(s)/tool(s) to modify.",
    "4. If the fix would require changing the **Supervisor** (`tools/supervisor/**`) or",
    "   BOS's build config, say so explicitly in the verdict and classify it `a` with a",
    "   note that self-heal cannot fix it — the Supervisor is off-limits (005 FR-001/FR-010).",
    "5. Call `submit_diagnostics_report` exactly once, with:",
    `   - \`caseId\`: "${record.id}"`,
    "   - `scopeClass`, `ownership`, `proposedSurface` (and `appId` for class d/d-bis)",
    "   - `verdict`: \"genuine gap\" or \"usage/agent error\", plus the one-line reason",
    "   - `reportMarkdown`: the investigation narrative (markdown, no frontmatter — the",
    "     tool writes the frontmatter itself). Include your citations inline.",
    "   - `proposedEdit` for class `b`/`c` only: the exact before/after text of ONE edit.",
    "",
    "You write nothing else. You do not delegate. You do not modify source.",
  ].join("\n");
}

// ── Running it ──────────────────────────────────────────────────────────────

export interface DiagnosisResult {
  ok: boolean;
  caseId: string;
  scopeClass?: ScopeClass;
  reportPath?: string;
  error?: string;
}

/**
 * Run the Diagnostician for one case and leave a validated report on disk.
 *
 * Called fire-and-forget from the spine's Phase A: a 034 core executor has a
 * timeout and must settle its ack immediately, so this multi-minute LLM step is
 * never awaited inside the handler (design ADR-1/R4).
 */
export async function runDiagnostician(caseId: string): Promise<DiagnosisResult> {
  const record = await getCase(caseId);
  if (!record) return { ok: false, caseId, error: `no case "${caseId}"` };

  const { getAgent, runSubAgent, saveConversationMessages } = await agentLayer();
  const agent = await getAgent(DIAGNOSTICIAN_AGENT_ID);
  if (!agent) {
    const error = `the Diagnostician agent "${DIAGNOSTICIAN_AGENT_ID}" is not installed`;
    await updateCase(caseId, { status: "failed", error, note: error });
    return { ok: false, caseId, error };
  }

  const facts = await ownershipFacts();
  const prompt = buildDiagnosticianPrompt(record, facts);
  const conversationId = diagnosticianConversationId(caseId);

  // Seed + mark the run's conversation. The seeded prompt is the audit artifact
  // ("what was the Diagnostician actually asked?"); the marker is the
  // re-entrancy backstop for the case where a human later drives this
  // conversation from the chat UI (design ADR-4).
  await saveConversationMessages(conversationId, DIAGNOSTICIAN_AGENT_ID, [
    { id: `m-${caseId}-diag`, role: "user", content: prompt },
  ]).catch(() => undefined);
  await markSelfHealConversation(conversationId, { role: "diagnostician", caseId }).catch(() => undefined);

  await updateCase(caseId, { status: "diagnosing", note: "Diagnostician launched" });

  const observer = await createRunObserver({
    caseId,
    role: "diagnostician",
    agentId: DIAGNOSTICIAN_AGENT_ID,
    agentName: agent.name,
  });
  const result = await runSubAgent(agent, prompt, { conversationId, contentOnly: true, onEvent: observer.onEvent });
  await recordCaseCost(caseId, "diagnostician", result.usage, [prompt, result.output]);
  const verdict = await observer.finish({
    ...(result.endedReason ? { endedReason: result.endedReason } : {}),
    ...(result.aborted !== undefined ? { aborted: result.aborted } : {}),
    ...(result.error ? { error: result.error } : {}),
  });

  // The user's Stop already put the case in `stopped` and owns its state — a
  // killed run must not be re-recorded as a failure (FR-034).
  if (verdict.aborted) {
    logger().info(SELF_HEAL_LOG, "diagnostician run was stopped", { caseId });
    return { ok: false, caseId, error: "the Diagnostician run was stopped" };
  }

  // FR-033(b), M1: the run used its whole step budget. Recoverable by Start
  // (with a complete transcript to read), so `stopped` rather than `failed`.
  if (verdict.stopCase) {
    const note = "the Diagnostician run used its whole step budget — stopped, restartable with Start";
    const stopped = await updateCase(caseId, { status: "stopped", stoppedFrom: "diagnosing", note });
    logger().warn(SELF_HEAL_LOG, "diagnostician hit max steps", { caseId });
    if (stopped) {
      await emitSelfHeal(SELF_HEAL_EVENTS.runStuck, {
        ...casePayload(stopped),
        ...(verdict.runId ? { runId: verdict.runId } : {}),
        summary: summaryFor(stopped, "stopped — the Diagnostician used its whole step budget"),
      });
    }
    return { ok: false, caseId, error: note };
  }

  if (result.error) {
    // FR-025: a failing Diagnostician must NOT create a new self-heal case. It
    // cannot, structurally — a headless run fires no plugin hook — so all that
    // is needed here is to record the failure on the case it belongs to.
    const error = `Diagnostician run failed: ${result.error}`;
    await updateCase(caseId, { status: "failed", error, note: error });
    logger().warn(SELF_HEAL_LOG, "diagnostician failed", { caseId, error: result.error });
    return { ok: false, caseId, error };
  }

  // The happy path is `submit_diagnostics_report` having already written the
  // report and stamped the case. Re-read rather than trust the run's text.
  const after = await getCase(caseId);
  if (after?.reportPath && after.scopeClass) {
    return { ok: true, caseId, scopeClass: after.scopeClass, reportPath: after.reportPath };
  }

  // Fallback: the agent answered in prose instead of calling the tool. Accept a
  // complete frontmatter+body document, reject anything less — a half-formed
  // verdict must not route a code change.
  const parsed = parseDiagnosticsReport(result.output ?? "");
  if ("error" in parsed) {
    const error = `the Diagnostician did not submit a usable report (${parsed.error})`;
    await updateCase(caseId, { status: "failed", error, note: error });
    return { ok: false, caseId, error };
  }
  const stored = await storeDiagnosticsReport(caseId, { ...parsed.frontmatter, caseId }, parsed.body);
  return { ok: true, caseId, scopeClass: parsed.frontmatter.scopeClass, reportPath: stored.reportPath };
}

/**
 * Write the report to the VFS and stamp the case with its verdict (FR-028).
 * Shared by the `submit_diagnostics_report` tool and the prose fallback above,
 * so there is exactly one writer of the report file and the case's verdict
 * fields.
 */
export async function storeDiagnosticsReport(
  caseId: string,
  frontmatter: DiagnosticsFrontmatter,
  body: string,
): Promise<{ reportPath: string }> {
  const reportPath = reportPathFor(caseId);
  await vfs.mkdir(REPORTS_DIR).catch(() => undefined);
  await vfs.writeText(reportPath, renderDiagnosticsReport({ ...frontmatter, caseId }, body));
  await updateCase(caseId, {
    status: "diagnosed",
    scopeClass: frontmatter.scopeClass,
    ownership: frontmatter.ownership,
    proposedSurface: frontmatter.proposedSurface,
    ...(frontmatter.appId ? { appId: frontmatter.appId } : {}),
    ...(frontmatter.verdict ? { verdict: frontmatter.verdict } : {}),
    reportPath,
    note: `diagnosed as class ${frontmatter.scopeClass} (${frontmatter.ownership}) — ${frontmatter.proposedSurface}`,
  });
  return { reportPath };
}

/**
 * One Mode-1 behavioral review, as the scheduled pass invokes it.
 *
 * Exported (rather than inlined in the pass) so the scheduled pass has exactly
 * two agent-run entry points, both replaceable through the seam below — which
 * is what makes the pass's bounding, deferral reporting and error handling
 * testable without a model.
 */
export async function runMode1Review(conversationId: string): Promise<{ ok: boolean; error?: string }> {
  const { getAgent, runSubAgent } = await agentLayer();
  const agent = await getAgent(DIAGNOSTICIAN_AGENT_ID);
  if (!agent) return { ok: false, error: `the Diagnostician agent "${DIAGNOSTICIAN_AGENT_ID}" is not installed` };
  const task = [
    "# Mode 1 — scheduled behavioral review",
    "",
    `Review conversation \`${conversationId}\` for BEHAVIORAL problems, following the`,
    "`agent-behavior-review` skill. Read every page. If there are no behavioral issues,",
    "write a short report saying so — that is a valid outcome and no case is created.",
  ].join("\n");
  const result = await runSubAgent(agent, task, { conversationId, contentOnly: true });
  return result.error ? { ok: false, error: result.error } : { ok: true };
}

// ── The scheduled pass (FR-021, design R6) ──────────────────────────────────

/** The scheduled pass's two agent-run entry points, isolated so the pass's
 *  deterministic behaviour (bounding, deferral reporting, error collection) is
 *  testable without a provider. Same `_…ForTests` convention as
 *  `_setSpineAgentHooksForTests` in intake.ts. */
export interface DiagnosticianRunners {
  diagnose: (caseId: string) => Promise<DiagnosisResult>;
  mode1: (conversationId: string) => Promise<{ ok: boolean; error?: string }>;
}

const DEFAULT_RUNNERS: DiagnosticianRunners = { diagnose: runDiagnostician, mode1: runMode1Review };
let runners: DiagnosticianRunners = DEFAULT_RUNNERS;

/** Tests only. `null` restores the real implementations. */
export function _setDiagnosticianRunnersForTests(overrides: Partial<DiagnosticianRunners> | null): void {
  runners = overrides ? { ...DEFAULT_RUNNERS, ...overrides } : DEFAULT_RUNNERS;
}


export const SELF_HEAL_SCHEDULER_REF = "self-heal.diagnostician";
export const SELF_HEAL_SCHEDULER_JOB_ID = "self-heal-diagnostician";
export const SELF_HEAL_SCHEDULER_OWNER = "self-heal";

export interface ScheduledPassSummary {
  skipped: boolean;
  mode1Reviewed: string[];
  mode2Diagnosed: string[];
  errors: string[];
}

/** Conversations whose last write is older than the idle threshold — "idle"
 *  defined as last-message age, sourced from the conversation store's own
 *  files rather than a raw glob (design R6). Self-heal-origin conversations are
 *  excluded: reviewing our own runs is exactly the recursion FR-025 forbids. */
export async function idleConversationIds(idleThresholdSec: number, now: number = Date.now()): Promise<string[]> {
  const entries = await vfs.list("/Documents/Chats").catch(() => []);
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.type !== "file" || !entry.name.endsWith(".json")) continue;
    const id = entry.name.replace(/\.json$/, "");
    if (id.startsWith("c-self-heal-")) continue;
    const modified = entry.modified ?? 0;
    if (!modified || now - modified < idleThresholdSec * 1000) continue;
    out.push(id);
  }
  return out;
}

/**
 * One scheduled pass: Mode 1 over idle conversations AND Mode 2 over cases
 * still waiting for diagnosis, in a single pass (FR-021).
 *
 * Bounded on purpose. Mode 1 reviews at most `maxMode1` conversations per tick
 * and Mode 2 drains at most `maxMode2` pending cases, because an unbounded pass
 * on a machine with hundreds of idle conversations would spend the whole daily
 * cost cap on its first tick. What was skipped is reported, never silently
 * dropped — the next tick picks it up.
 */
export async function runScheduledDiagnosticianPass(opts?: {
  maxMode1?: number;
  maxMode2?: number;
  now?: number;
}): Promise<ScheduledPassSummary> {
  const summary: ScheduledPassSummary = { skipped: false, mode1Reviewed: [], mode2Diagnosed: [], errors: [] };
  const cfg = await readSelfHealConfig();
  if (!cfg.enabled || !cfg.diagnostician.scheduled) {
    summary.skipped = true;
    return summary;
  }
  const { capExhaustedForToday } = await import("./cost");
  if (await capExhaustedForToday(opts?.now)) {
    summary.skipped = true;
    summary.errors.push("daily cost cap already reached — scheduled pass deferred");
    return summary;
  }

  const maxMode1 = opts?.maxMode1 ?? 3;
  const maxMode2 = opts?.maxMode2 ?? 3;

  // ── Mode 2: cases that never got diagnosed (a crashed run, or a case that
  // was parked behind the cost cap and is now affordable again).
  const { listCases } = await import("./store");
  const { resolveDiagnosedCase } = await import("./intake");
  const pending = (await listCases()).filter((c) => c.status === "new" || c.status === "diagnosing" || c.status === "queued-cost");
  for (const record of pending.slice(0, maxMode2)) {
    try {
      const outcome = await runners.diagnose(record.id);
      if (outcome.ok) {
        summary.mode2Diagnosed.push(record.id);
        await resolveDiagnosedCase(record.id);
      } else if (outcome.error) {
        summary.errors.push(`${record.id}: ${outcome.error}`);
      }
    } catch (err) {
      summary.errors.push(`${record.id}: ${(err as Error).message}`);
    }
  }

  // ── Mode 1: behavioral review of idle conversations.
  const ids = await idleConversationIds(cfg.diagnostician.idleThresholdSec, opts?.now);
  if (ids.length > maxMode1) {
    summary.errors.push(`${ids.length - maxMode1} idle conversation(s) deferred to the next pass (per-pass cap ${maxMode1})`);
  }
  for (const conversationId of ids.slice(0, maxMode1)) {
    try {
      const result = await runners.mode1(conversationId);
      if (result.ok) summary.mode1Reviewed.push(conversationId);
      else summary.errors.push(`${conversationId}: ${result.error ?? "review failed"}`);
    } catch (err) {
      summary.errors.push(`${conversationId}: ${(err as Error).message}`);
    }
  }
  return summary;
}

/** Register the scheduled pass as a recurring system job (FR-021). Idempotent;
 *  called at boot from src/instrumentation.ts. */
export async function ensureScheduledDiagnosticianJob(): Promise<void> {
  const [{ registerInternalRef }, { ensureSystemJob }] = await Promise.all([
    import("@/lib/agent/memory/internal-handler"),
    import("@/lib/scheduler/engine"),
  ]);
  registerInternalRef(SELF_HEAL_SCHEDULER_REF, async () => {
    const summary = await runScheduledDiagnosticianPass();
    if (summary.errors.length) {
      return {
        status: "error" as const,
        error: summary.errors.join("; "),
        output: `mode1=${summary.mode1Reviewed.length} mode2=${summary.mode2Diagnosed.length}`,
      };
    }
    return {
      status: "success" as const,
      output: summary.skipped
        ? "scheduled Diagnostician disabled — no work done"
        : `mode1=${summary.mode1Reviewed.length} mode2=${summary.mode2Diagnosed.length}`,
    };
  });
  const cfg = await readSelfHealConfig();
  // Tick at the idle threshold (floored to a minute): checking more often than
  // a conversation can become idle is pure waste.
  const intervalMinutes = Math.max(1, Math.round(cfg.diagnostician.idleThresholdSec / 60));
  await ensureSystemJob({
    id: SELF_HEAL_SCHEDULER_JOB_ID,
    name: "Self-Heal: Diagnostician",
    owner: SELF_HEAL_SCHEDULER_OWNER,
    handler: { kind: "internal", ref: SELF_HEAL_SCHEDULER_REF },
    scheduleConfig: { type: "recurring", interval: intervalMinutes, unit: "minute" },
    readOnlyFields: ["handler"],
  });
}
