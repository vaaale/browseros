import "server-only";
import type { AssistantTool } from "../../tools";
import { serverTool, schema, p } from "./util";
import { selfHealIntake, suspendCase, completeFix } from "@/lib/self-heal/intake";
import { getCase, listCases } from "@/lib/self-heal/store";
import { readSelfHealConfig } from "@/lib/self-heal/config";
import { humanCaseId, type TriggerContext } from "@/lib/self-heal/types";

// The self-heal agent tools (031-self-healing FR-001/FR-016/FR-017).
//
// Naming: the spec writes these as `self_heal.request` etc. Tool NAMES cannot
// contain a dot — every provider constrains them to `[a-zA-Z0-9_-]` — so the
// ids are `self_heal_request`, `self_heal_request_decision`,
// `self_heal_complete_fix`. The dotted names in the spec refer to these.
// (Event TYPES do use dots: `com.bos.self-heal.*`.)
//
// All three are server tools: they call the spine in-process, so an agent
// running headless inside the autonomous pipeline can reach them (a frontend
// tool could not — a headless run has no browser to dispatch to).

export function selfHealTools(): Record<string, AssistantTool> {
  return {
    self_heal_request: serverTool(
      "self_heal_request",
      "Report a problem to BrowserOS's self-healing mechanism. Creates a Healing Case, which a Diagnostician investigates: it reads BOS's own source, decides whether this is a genuine gap or a usage error, and classifies the fix surface (environment / skill / workflow / marketplace app / BOS core). A genuine BOS-core gap or a bug in an app the user maintains is then fixed autonomously on a preview the user promotes; nothing is ever promoted automatically. Use this when something in BOS itself appears broken or missing — not for a task failing because of a network blip, a missing API key, or a rate limit (those are filtered out anyway). Duplicate reports of the same problem within an hour are suppressed and linked to the original case.",
      schema(
        {
          description: p.str(
            "What went wrong, concretely: what you tried, what you expected, what happened instead. This is the Diagnostician's starting point, so specifics beat adjectives.",
          ),
          toolName: p.str("The tool or subsystem involved, if you know it (e.g. \"bos_app_launch\")."),
          errorMessage: p.str("The exact error text, if there was one."),
          conversationId: p.str("The conversation where this happened, if it was a conversation."),
          eventId: p.str("A related event id, if there is one."),
          filePath: p.str("A file path involved in the failure, if any."),
          appId: p.str("The app or marketplace item id involved, if any."),
        },
        ["description"],
      ),
      async (input, ctx) => {
        const description = String(input.description ?? "").trim();
        if (!description) return "No description provided — say what went wrong.";
        const trigger: TriggerContext = {
          trigger: "explicit",
          description,
          ...(input.toolName ? { toolName: String(input.toolName) } : {}),
          ...(input.errorMessage ? { errorMessage: String(input.errorMessage) } : {}),
          conversationId: String(input.conversationId ?? ctx.conversationId ?? "") || undefined,
          ...(input.eventId ? { eventId: String(input.eventId) } : {}),
          ...(input.filePath ? { filePath: String(input.filePath) } : {}),
          ...(input.appId ? { appId: String(input.appId) } : {}),
        };
        const outcome = await selfHealIntake(trigger);
        switch (outcome.action) {
          case "disabled":
            return "Self-healing is switched off (Settings → Self Improvement). No case was created.";
          case "trigger-disabled":
            return `The explicit self-heal trigger is disabled (Settings → Self Improvement). No case was created.`;
          case "reentrancy-skipped":
            return `Skipped: ${outcome.reason}. A self-heal run cannot report problems about itself.`;
          case "environmental":
            return "Not created: this looks like an unconditionally external failure (network, DNS, auth, rate limit, OOM). Retry once the environment recovers.";
          case "not-bos-owned":
            return `Not created: ${outcome.reason}.`;
          case "duplicate":
            return `Already known — this matches open case ${humanCaseId(outcome.originalCaseId)}. No duplicate case was created; watch that one in Build Studio → Self-Heal.`;
          case "queued-cost":
            return `Created case ${humanCaseId(outcome.caseId)}, but today's self-heal token budget is spent — it is queued and will be diagnosed after the next UTC midnight.`;
          case "created":
            return `Created case ${humanCaseId(outcome.caseId)}. The Diagnostician is investigating; follow it in Build Studio → Self-Heal.`;
        }
      },
    ),

    self_heal_request_decision: serverTool(
      "self_heal_request_decision",
      "Suspend an autonomous self-heal fix and ask the user a question you cannot answer yourself. Use this — and only this — when the autonomous pipeline hits a decision it must not guess: a scope choice that changes which file gets modified, a classification divergence that survived one re-diagnosis, a required change to a file outside the plan's approved list, or missing information no research can supply. The case is parked, the user is notified, and this run ends; a new run resumes the same conversation with their answer. Never park on a message and wait instead — nobody is watching this conversation.",
      schema(
        {
          caseId: p.str("The self-heal case id from your brief."),
          question: p.str(
            "The question, written for someone who has not read this conversation: what the choice is, what each option implies, and what you recommend.",
          ),
        },
        ["caseId", "question"],
      ),
      async (input) => {
        const caseId = String(input.caseId ?? "").trim();
        const question = String(input.question ?? "").trim();
        if (!caseId) return "No caseId provided.";
        if (!question) return "No question provided — the user needs to know what is being asked.";
        const record = await getCase(caseId);
        if (!record) return `There is no self-heal case "${caseId}".`;
        const updated = await suspendCase(caseId, question);
        if (!updated) return `Could not suspend case ${caseId}.`;
        return `Case ${humanCaseId(caseId)} is suspended and the user has been notified. Stop here — a new run will resume this conversation with their answer.`;
      },
    ),

    self_heal_complete_fix: serverTool(
      "self_heal_complete_fix",
      "Declare a self-heal fix complete and notify the user that it is ready to review. Call this at the very end of `implement`, once the preview is healthy (typecheck + build + health pass) and the test suite passes — for class e pass the branch, for class d-bis pass the appId. BOS re-checks the preview's real build state with the Supervisor before notifying, so calling this early reports the case as FAILED rather than ready. This does NOT promote anything: promotion is always the user's explicit action.",
      schema(
        {
          caseId: p.str("The self-heal case id from your brief."),
          branch: p.str("Class e: the feature branch the fix landed on (bos/self-heal-<caseId>)."),
          appId: p.str("Class d-bis: the marketplace item id that was rebuilt via app_build."),
          summary: p.str("One paragraph, for the user: what was broken, what changed, and what the test proves."),
          link: p.str("Optional deep link to show the user."),
        },
        ["caseId", "summary"],
      ),
      async (input) => {
        const caseId = String(input.caseId ?? "").trim();
        const summary = String(input.summary ?? "").trim();
        if (!caseId) return "No caseId provided.";
        if (!summary) return "No summary provided — the user needs to know what changed.";
        const outcome = await completeFix({
          caseId,
          summary,
          ...(input.branch ? { branch: String(input.branch) } : {}),
          ...(input.appId ? { appId: String(input.appId) } : {}),
          ...(input.link ? { link: String(input.link) } : {}),
        });
        if (!outcome.ok) return `Could not complete the fix: ${outcome.error}`;
        const where = outcome.record.activeFeatureBranch
          ? `on ${outcome.record.activeFeatureBranch}`
          : `in app "${outcome.record.appId}"`;
        return `Case ${humanCaseId(caseId)} is ready ${where}. The user has been notified and will promote or discard it — you do not promote.`;
      },
    ),

    self_heal_status: serverTool(
      "self_heal_status",
      "Report the self-healing mechanism's current state: whether it is enabled, which triggers are on, and every Healing Case with its status and scope class. Read-only. Use it to answer \"is anything being fixed right now?\" or to find the case id for a problem you already reported.",
      schema({ caseId: p.str("Optional: one case id, for its full record instead of the list.") }),
      async (input) => {
        const cfg = await readSelfHealConfig();
        const caseId = String(input.caseId ?? "").trim();
        if (caseId) {
          const record = await getCase(caseId);
          if (!record) return `There is no self-heal case "${caseId}".`;
          return JSON.stringify({ enabled: cfg.enabled, case: record }, null, 2);
        }
        const cases = await listCases();
        return JSON.stringify(
          {
            enabled: cfg.enabled,
            triggers: cfg.triggers,
            autonomousImplement: cfg.autonomousImplement,
            cases: cases.map((c) => ({
              id: c.id,
              humanId: humanCaseId(c.id),
              status: c.status,
              scopeClass: c.scopeClass,
              trigger: c.trigger,
              title: c.title,
              proposedSurface: c.proposedSurface,
              branch: c.activeFeatureBranch,
              appId: c.appId,
            })),
          },
          null,
          2,
        );
      },
    ),
  };
}
