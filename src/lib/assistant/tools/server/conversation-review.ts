import "server-only";
import * as vfs from "@/os/vfs";
import type { AssistantTool } from "../../tools";
import { serverTool, schema, p } from "./util";
import { paginateConversation, segmentIntoTurns, renderMessages, type AnyMessage } from "@/lib/agent/conversation-chunking";

// Tools for the conversation-reviewer agent: read a PAST conversation
// (any conversationId, not just the caller's own) in verifiable pages, then
// submit findings. The one thing this file exists to guarantee: a review
// cannot be silently partial. submit_review_report independently recomputes
// the conversation's true page count from the live file — never trusts the
// caller's own claim of how many pages exist — and refuses to write the
// report unless every page was actually fetched. This is the same principle
// behind every "stop reporting optimistic success" fix made this session
// (web_view, buildstudio_artifact_open): the tool verifies, it doesn't trust.
//
// 031-self-healing (FR-008 / clarification Q8) changed the OUTPUT FORMAT only:
// the report is now markdown (YAML frontmatter + narrative) rather than JSON,
// matching Mode 2's `submit_diagnostics_report` so both of the reviewer's modes
// produce the same kind of artifact. Non-destructive: these reports are
// write-only human artifacts in /Documents/BOS Improvements/ — nothing in BOS
// reads them programmatically. The page-count recompute gate above is
// deliberately UNCHANGED; it is the integrity guarantee, not part of the
// format.

const CHATS_DIR = "/Documents/Chats";
const REPORTS_DIR = "/Documents/BOS Improvements";

interface ConversationFile {
  id?: string;
  title?: string;
  agentId?: string;
  messages?: AnyMessage[];
}

async function loadConversationFile(conversationId: string): Promise<ConversationFile | undefined> {
  try {
    const raw = await vfs.readText(`${CHATS_DIR}/${conversationId}.json`);
    const parsed = JSON.parse(raw) as ConversationFile;
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Best-effort: which sub-agents this conversation delegated to, mined from
 *  agent_delegate/dev_delegate tool-call arguments (delegated runs don't tag
 *  their own messages with an agent id — see agent-loop.ts's blank inner
 *  transcript — so this is the only signal available from the transcript
 *  alone). Not exhaustive; a genuinely thorough review still reads the
 *  content and sees who was delegated to. */
function collectDelegatedAgents(messages: AnyMessage[]): string[] {
  const ids = new Set<string>();
  for (const m of messages) {
    const calls = Array.isArray(m?.toolCalls) ? m.toolCalls : [];
    for (const c of calls) {
      if (!c || typeof c !== "object") continue;
      const call = c as { name?: unknown; toolName?: unknown; input?: unknown; arguments?: unknown };
      const name = String(call.name ?? call.toolName ?? "");
      if (name !== "agent_delegate" && name !== "dev_delegate") continue;
      let input = (call.input ?? call.arguments ?? {}) as Record<string, unknown> | string;
      if (typeof input === "string") {
        try { input = JSON.parse(input) as Record<string, unknown>; } catch { input = {}; }
      }
      const agentId = String((input as Record<string, unknown>).agent ?? "").trim();
      if (agentId) ids.add(agentId);
      else if (name === "dev_delegate") ids.add("developer");
    }
  }
  return Array.from(ids);
}

// ── Markdown rendering (031-self-healing FR-008 / Q8) ───────────────────────
//
// The agent still submits the same structured `report` object — that shape is
// the contract the skill documents and the thing that keeps a review
// comparable across conversations. Only the SAVED artifact changed: it is
// rendered here into markdown, so the file a human opens reads like a document
// instead of a JSON dump. Anything the agent included that this renderer
// doesn't know about is appended verbatim under "Additional fields" rather
// than dropped — losing part of a review to make the output tidy would be the
// wrong trade.

interface ReviewRenderInput {
  reviewId: string;
  conversationId: string;
  conversationTitle: string;
  reviewedAt: string;
  totalPages: number;
  report: Record<string, unknown>;
}

function yamlScalar(value: unknown): string {
  return JSON.stringify(String(value ?? ""));
}

function asArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((v): v is Record<string, unknown> => !!v && typeof v === "object") : [];
}

function str(o: Record<string, unknown>, key: string): string {
  const v = o[key];
  return typeof v === "string" ? v : v === undefined || v === null ? "" : String(v);
}

function renderProposedChange(change: Record<string, unknown>, index: number): string[] {
  const lines: string[] = [];
  const id = str(change, "changeId") || `C${index + 1}`;
  lines.push(`#### Proposed change ${id} — ${str(change, "artifactType") || "unknown artifact"}`);
  lines.push("");
  if (str(change, "targetPath")) lines.push(`- **Target**: \`${str(change, "targetPath")}\``);
  if (str(change, "changeType")) lines.push(`- **Change type**: ${str(change, "changeType")}`);
  lines.push(`- **Approved**: ${change.approved === null || change.approved === undefined ? "null (a human decides)" : String(change.approved)}`);
  if (str(change, "rationale")) {
    lines.push("");
    lines.push(str(change, "rationale"));
  }
  const before = str(change, "before");
  const after = str(change, "after");
  if (before) {
    lines.push("");
    lines.push("**Before**");
    lines.push("");
    lines.push("```text");
    lines.push(before);
    lines.push("```");
  }
  if (after) {
    lines.push("");
    lines.push("**After**");
    lines.push("");
    lines.push("```text");
    lines.push(after);
    lines.push("```");
  }
  return lines;
}

export function renderReviewMarkdown(input: ReviewRenderInput): string {
  const r = input.report;
  const known = new Set(["summary", "primaryAgentId", "delegatedAgentIds", "findings", "newSkillProposals"]);
  const frontmatter = [
    "---",
    `reviewId: ${yamlScalar(input.reviewId)}`,
    `conversationId: ${yamlScalar(input.conversationId)}`,
    `conversationTitle: ${yamlScalar(input.conversationTitle)}`,
    `reviewedAt: ${input.reviewedAt}`,
    `totalPages: ${input.totalPages}`,
    "status: pending-approval",
    `mode: behavioral-review`,
    ...(str(r, "primaryAgentId") ? [`primaryAgentId: ${yamlScalar(str(r, "primaryAgentId"))}`] : []),
    "---",
  ];

  const body: string[] = [`# Conversation review — ${input.conversationTitle}`, ""];
  body.push(`Reviewed all ${input.totalPages} page(s) of \`${input.conversationId}\`.`, "");
  if (str(r, "summary")) {
    body.push("## Summary", "", str(r, "summary"), "");
  }
  const delegated = Array.isArray(r.delegatedAgentIds) ? r.delegatedAgentIds.map((a) => String(a)) : [];
  if (str(r, "primaryAgentId") || delegated.length) {
    body.push("## Agents involved", "");
    if (str(r, "primaryAgentId")) body.push(`- **Primary**: ${str(r, "primaryAgentId")}`);
    if (delegated.length) body.push(`- **Delegated to**: ${delegated.join(", ")}`);
    body.push("");
  }

  const findings = asArray(r.findings);
  body.push("## Findings", "");
  if (findings.length === 0) {
    body.push("No behavioral issues found — that is a valid outcome, not an incomplete review.", "");
  } else {
    for (const f of findings) {
      const id = str(f, "id");
      body.push(`### ${id ? `${id} — ` : ""}${str(f, "title") || "(untitled finding)"}`, "");
      const meta = [
        str(f, "severity") ? `**Severity**: ${str(f, "severity")}` : "",
        str(f, "category") ? `**Category**: ${str(f, "category")}` : "",
      ].filter(Boolean);
      if (meta.length) body.push(meta.join(" · "), "");
      if (str(f, "description")) body.push(str(f, "description"), "");
      const evidence = asArray(f.evidence);
      if (evidence.length) {
        body.push("**Evidence**", "");
        for (const e of evidence) {
          body.push(`- page ${str(e, "page") || "?"} (${str(e, "role") || "?"}): ${str(e, "excerpt")}`);
        }
        body.push("");
      }
      if (str(f, "rootCause")) body.push("**Root cause**", "", str(f, "rootCause"), "");
      const changes = asArray(f.proposedChanges);
      changes.forEach((c, i) => {
        body.push(...renderProposedChange(c, i), "");
      });
    }
  }

  const proposals = asArray(r.newSkillProposals);
  if (proposals.length) {
    body.push("## New skill proposals", "");
    for (const p of proposals) {
      body.push(`### ${str(p, "proposedId") || "(unnamed)"}`, "");
      if (str(p, "rationale")) body.push(str(p, "rationale"), "");
      if (str(p, "outline")) body.push("**Outline**", "", str(p, "outline"), "");
    }
  }

  const extra = Object.keys(r).filter((k) => !known.has(k));
  if (extra.length) {
    body.push("## Additional fields", "");
    body.push("```json");
    body.push(JSON.stringify(Object.fromEntries(extra.map((k) => [k, r[k]])), null, 2));
    body.push("```", "");
  }

  return `${frontmatter.join("\n")}\n\n${body.join("\n").trimEnd()}\n`;
}

export function conversationReviewTools(): Record<string, AssistantTool> {
  return {
    conversation_overview: serverTool(
      "conversation_overview",
      "Get the shape of a past conversation BEFORE reviewing it: title, primary agent, sub-agents it delegated to, and total pages (see conversation_page). Call this first, every time — it tells you exactly how many pages you must cover; guessing is what leads to a review that silently stops partway through.",
      schema({ conversationId: p.str('The conversation id, e.g. "c-abc123" — the file is /Documents/Chats/<id>.json.') }, ["conversationId"]),
      async (input) => {
        const id = String(input.conversationId ?? "").trim();
        if (!id) return "No conversationId provided.";
        const file = await loadConversationFile(id);
        if (!file) return `No conversation found at /Documents/Chats/${id}.json.`;
        const messages = Array.isArray(file.messages) ? file.messages : [];
        const totalPages = paginateConversation(messages).length;
        return JSON.stringify(
          {
            conversationId: id,
            title: file.title ?? "(untitled)",
            primaryAgentId: file.agentId ?? "(unknown)",
            delegatedAgentIds: collectDelegatedAgents(messages),
            totalMessages: messages.length,
            totalTurns: segmentIntoTurns(messages).length,
            totalPages,
            instructions:
              totalPages > 0
                ? `Call conversation_page for EVERY page from 1 to ${totalPages} before calling submit_review_report — it will refuse to save if any page is missing.`
                : "This conversation has no messages to review.",
          },
          null,
          2,
        );
      },
    ),

    conversation_page: serverTool(
      "conversation_page",
      "Fetch ONE page (1-indexed) of a conversation's transcript, condensed for review — role, content, and tool calls/results per message, turn-safe (a tool call is never separated from its result). Call conversation_overview first to learn how many pages exist. You must fetch every page before submit_review_report will accept the review.",
      schema(
        {
          conversationId: p.str("The conversation id."),
          page: p.num("1-indexed page number, from conversation_overview's totalPages."),
        },
        ["conversationId", "page"],
      ),
      async (input) => {
        const id = String(input.conversationId ?? "").trim();
        const page = Number(input.page);
        if (!id) return "No conversationId provided.";
        const file = await loadConversationFile(id);
        if (!file) return `No conversation found at /Documents/Chats/${id}.json.`;
        const messages = Array.isArray(file.messages) ? file.messages : [];
        const pages = paginateConversation(messages);
        if (!Number.isInteger(page) || page < 1 || page > pages.length) {
          return `Invalid page ${input.page} — this conversation has ${pages.length} page(s) (1-${pages.length}). Call conversation_overview if you're unsure of the range.`;
        }
        const content = pages[page - 1].map((turn) => renderMessages(turn)).join("\n\n---\n\n");
        return JSON.stringify({ page, totalPages: pages.length, content }, null, 2);
      },
    ),

    submit_review_report: serverTool(
      "submit_review_report",
      'Finalize and save a conversation-behavior review report as markdown to /Documents/BOS Improvements/<reviewId>.md. REFUSES to save — and tells you exactly which pages are missing — unless `pagesReviewed` covers every page from conversation_overview\'s totalPages, independently recomputed here from the live conversation file (your own claim of the total is not trusted). This is a hard check, not a formality: it is the only thing preventing a review from stopping partway through a long conversation and reporting as if it were complete. See the agent-behavior-review skill for the `report` object\'s expected shape.',
      schema(
        {
          conversationId: p.str("The conversation id this review is for."),
          reviewId: p.str('A short, descriptive slug for this review, e.g. "build-studio-webdav-2026-08-02" — used as the output filename.'),
          pagesReviewed: {
            type: "array",
            items: { type: "number" },
            description: "Every page number (from conversation_page) you actually fetched, in any order — must cover 1..totalPages with no gaps.",
          },
          report: p.obj("The review report object — summary, findings[], newSkillProposals[]. See the agent-behavior-review skill for the exact schema."),
        },
        ["conversationId", "reviewId", "pagesReviewed", "report"],
      ),
      async (input) => {
        const conversationId = String(input.conversationId ?? "").trim();
        const reviewId = String(input.reviewId ?? "").trim().replace(/[^a-zA-Z0-9._-]/g, "-");
        if (!conversationId) return "No conversationId provided.";
        if (!reviewId) return "No reviewId provided.";
        const file = await loadConversationFile(conversationId);
        if (!file) return `No conversation found at /Documents/Chats/${conversationId}.json.`;
        const messages = Array.isArray(file.messages) ? file.messages : [];
        const totalPages = paginateConversation(messages).length;

        const reviewedInput = Array.isArray(input.pagesReviewed) ? input.pagesReviewed : [];
        const reviewed = new Set(reviewedInput.map((n) => Number(n)).filter((n) => Number.isInteger(n)));
        const missing: number[] = [];
        for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
          if (!reviewed.has(pageNum)) missing.push(pageNum);
        }
        if (missing.length > 0) {
          return `Cannot submit — ${missing.length} of ${totalPages} page(s) were never reviewed: ${missing.join(", ")}. Call conversation_page for each missing page, then resubmit with the complete pagesReviewed list.`;
        }

        const reportBody = typeof input.report === "object" && input.report ? (input.report as Record<string, unknown>) : {};
        await vfs.mkdir(REPORTS_DIR).catch(() => undefined);
        const outPath = `${REPORTS_DIR}/${reviewId}.md`;
        await vfs.writeText(
          outPath,
          renderReviewMarkdown({
            reviewId,
            conversationId,
            conversationTitle: file.title ?? "(untitled)",
            reviewedAt: new Date().toISOString(),
            totalPages,
            report: reportBody,
          }),
        );
        return `Saved review report to ${outPath} (all ${totalPages} page(s) covered).`;
      },
    ),
  };
}
