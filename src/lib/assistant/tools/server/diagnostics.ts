import "server-only";
import type { AssistantTool } from "../../tools";
import { serverTool, schema, p } from "./util";
import { storeDiagnosticsReport } from "@/lib/self-heal/diagnostician";
import { setProposedEdit } from "@/lib/self-heal/intake";
import { getCase } from "@/lib/self-heal/store";
import { hasSourceCitation, isOwnership, isScopeClass } from "@/lib/self-heal/report";
import { OWNERSHIPS, SCOPE_CLASSES, type ProposedEdit } from "@/lib/self-heal/types";

// `submit_diagnostics_report` — the Diagnostician's ONE write (031-self-healing
// FR-007/FR-028, design ADR-2).
//
// The agent is read-only everywhere else. That is enforced by its tool set, not
// by its prompt, and this tool is scoped the same way: it can only ever write
// `/Documents/BOS Improvements/self-heal-<caseId>.md`, for a caseId that already
// exists in the case store. There is no path parameter.
//
// It also VERIFIES rather than trusts, in the same spirit as
// `submit_review_report`'s page-count recompute: a report missing a scope class,
// an ownership, a proposed surface, or a single source citation is REFUSED with
// the specific reason, because the spine routes a code-changing pipeline off
// these fields. A refusal is a to-do list, not an error to work around.

function parseProposedEdit(raw: unknown): ProposedEdit | { error: string } | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return { error: "proposedEdit was a string that is not valid JSON" };
    }
  }
  if (!value || typeof value !== "object") return { error: "proposedEdit must be an object" };
  const e = value as Record<string, unknown>;
  const artifactType = e.artifactType === "workflow" ? "workflow" : e.artifactType === "skill" ? "skill" : undefined;
  if (!artifactType) return { error: 'proposedEdit.artifactType must be "skill" or "workflow"' };
  const target = typeof e.target === "string" ? e.target.trim() : "";
  const before = typeof e.before === "string" ? e.before : "";
  const after = typeof e.after === "string" ? e.after : "";
  if (!target) return { error: "proposedEdit.target is required (a skill id, or a /Workflows/<id>.json path)" };
  if (!before) return { error: "proposedEdit.before is required — the exact existing text to replace" };
  if (!after) return { error: "proposedEdit.after is required — the exact replacement text" };
  return {
    artifactType,
    target,
    before,
    after,
    ...(typeof e.rationale === "string" && e.rationale.trim() ? { rationale: e.rationale.trim() } : {}),
  };
}

export function diagnosticsTools(): Record<string, AssistantTool> {
  return {
    submit_diagnostics_report: serverTool(
      "submit_diagnostics_report",
      "Finalize and save the Mode-2 diagnostics report for a self-heal case to /Documents/BOS Improvements/self-heal-<caseId>.md (markdown + YAML frontmatter). This is the Diagnostician's ONLY write — there is no path parameter and it can write nowhere else. REFUSES, with the specific reason, unless: the caseId exists, scopeClass is one of a|b|c|d|d-bis|e, ownership is one of bos-core|user-app|marketplace|workflow|env, proposedSurface names a concrete file/tool/skill/workflow, and the narrative contains at least one source citation (a path like src/lib/foo.ts:42, or a spec reference). Those fields route a code-changing pipeline, so an almost-right report is rejected rather than coerced. For scope class b or c, also pass `proposedEdit` with the exact before/after text of ONE edit — the user approves it from the Build Studio Self-Heal page.",
      schema(
        {
          caseId: p.str("The self-heal case id you were given in the prompt (e.g. \"0001\")."),
          scopeClass: p.str(`The scope classification — one of: ${SCOPE_CLASSES.join(", ")}.`),
          ownership: p.str(`Who owns the fix surface — one of: ${OWNERSHIPS.join(", ")}.`),
          proposedSurface: p.str(
            "The SPECIFIC thing to modify: a file path (+ symbol), a tool name, a skill id, or a /Workflows/<id>.json path. Not a subsystem, not a description of the problem.",
          ),
          verdict: p.str('Either "genuine gap: <the exact missing surface>" or "usage/agent error: <the correct invocation>".'),
          reportMarkdown: p.str(
            "The investigation narrative in markdown, WITHOUT frontmatter (this tool writes the frontmatter). Every claim about BOS's current behavior needs an inline citation.",
          ),
          appId: p.str("For scope class d / d-bis only: the marketplace item id the failure points at."),
          proposedEdit: p.obj(
            'For scope class b / c only: { artifactType: "skill" | "workflow", target, before, after, rationale? } — ONE concrete edit, exact text.',
          ),
        },
        ["caseId", "scopeClass", "ownership", "proposedSurface", "reportMarkdown"],
      ),
      async (input) => {
        const caseId = String(input.caseId ?? "").trim();
        if (!caseId) return "Cannot submit — no caseId provided.";
        const record = await getCase(caseId);
        if (!record) return `Cannot submit — there is no self-heal case "${caseId}". Use the case id from your prompt.`;

        const scopeClass = String(input.scopeClass ?? "").trim();
        if (!isScopeClass(scopeClass)) {
          return `Cannot submit — scopeClass "${scopeClass}" is not one of: ${SCOPE_CLASSES.join(", ")}.`;
        }
        const ownership = String(input.ownership ?? "").trim();
        if (!isOwnership(ownership)) {
          return `Cannot submit — ownership "${ownership}" is not one of: ${OWNERSHIPS.join(", ")}.`;
        }
        const proposedSurface = String(input.proposedSurface ?? "").trim();
        if (!proposedSurface) {
          return "Cannot submit — proposedSurface is required: name the specific file, tool, skill or workflow to modify.";
        }
        const body = String(input.reportMarkdown ?? "").trim();
        if (!body) return "Cannot submit — reportMarkdown is empty. The investigation narrative is the report.";
        if (!hasSourceCitation(body)) {
          return "Cannot submit — the narrative contains no source citation. Every claim about BOS's current behavior needs a `path/to/file.ts:LINE` reference (or a spec reference); go read the source and cite it.";
        }

        let edit: ProposedEdit | undefined;
        if (scopeClass === "b" || scopeClass === "c") {
          const parsed = parseProposedEdit(input.proposedEdit);
          if (parsed && "error" in parsed) return `Cannot submit — ${parsed.error}.`;
          edit = parsed;
        }

        const verdict = String(input.verdict ?? "").trim();
        const appId = String(input.appId ?? "").trim();
        const { reportPath } = await storeDiagnosticsReport(
          caseId,
          {
            caseId,
            scopeClass,
            ownership,
            proposedSurface,
            triggeredAt: new Date(record.createdAt).toISOString(),
            ...(verdict ? { verdict } : {}),
            ...(appId ? { appId } : {}),
          },
          body,
        );
        if (edit) await setProposedEdit(caseId, edit);

        return [
          `Saved the diagnostics report to ${reportPath}.`,
          `Case ${caseId} is now class ${scopeClass} (${ownership}), surface: ${proposedSurface}.`,
          edit ? `Proposed ${edit.artifactType} edit to ${edit.target} recorded — it awaits the user's approval.` : "",
          "The spine routes from here; you are done.",
        ]
          .filter(Boolean)
          .join(" ");
      },
    ),
  };
}
