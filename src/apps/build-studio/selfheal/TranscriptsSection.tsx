"use client";

import { useMemo, useState } from "react";
import { Brain, Loader2 } from "lucide-react";
import { ChatMarkdown } from "@/components/agent/v2/ChatMarkdown";
import { ToolCallCard, type ToolCardData } from "@/components/agent/v2/ToolCallCard";
import { CardScopeProvider } from "@/lib/agent/card-collapse";
import type { CaseRun, HealingCase } from "@/lib/self-heal/types";
import { useRunTranscript, type TranscriptEntry } from "./useSelfHealCases";

// The case-detail "Transcripts" section (031-self-healing scope-add, FR-022f /
// FR-031/FR-037, mockup.html §2 "Transcripts · linked headless runs").
//
// This is the answer to the question the motivating incident left unanswerable:
// "what is that run actually DOING?" Every headless run the case launched is
// listed from `case.runs` (the case record is the authority — no filesystem
// scan), and the selected one's transcript is rendered as a CONVERSATION with
// the same components the live Assistant chat uses (FR-031): ChatMarkdown for
// assistant text, ToolCallCard for tool calls, a collapsible block for
// reasoning. The data source is the structured .ndjson companion (FR-037); a
// run recorded before the companion existed falls back to its markdown, verbatim.
//
// Two details are deliberate:
//   * The default selection is the most-recent IN-FLIGHT run, else the
//     most-recent one — because the run you want to look at is almost always
//     the one still going.
//   * The repeated call the stuck detector found is highlighted here, in the
//     RENDERER, not in the file. The platform transcript stays free of any
//     self-heal concept (design ADR-10); the pane cross-references the case's
//     recorded stuck signature to ring the matching tool cards (or colour the
//     matching lines, in the markdown fallback).

const CARD = "rounded-lg border border-white/10 bg-white/[0.03] p-3";

const RUN_STATUS_TONE: Record<CaseRun["status"], string> = {
  "in-flight": "text-violet-300",
  completed: "text-emerald-300",
  failed: "text-red-400",
  aborted: "text-amber-300",
  stopped: "text-amber-200/70",
};

const RUN_STATUS_LABEL: Record<CaseRun["status"], string> = {
  "in-flight": "In-flight",
  completed: "Completed",
  failed: "Failed",
  aborted: "Aborted",
  stopped: "Stopped",
};

const ROLE_LABEL: Record<CaseRun["role"], string> = {
  diagnostician: "Diagnostician",
  pipeline: "Pipeline",
};

/** The most useful run to show first: whatever is still running, else the
 *  newest one that ran. */
function defaultRunId(runs: CaseRun[]): string | undefined {
  const live = [...runs].reverse().find((r) => r.status === "in-flight");
  return (live ?? runs[runs.length - 1])?.runId;
}

/** One renderable row of the conversation: the three text kinds carry their
 *  markdown, a tool call carries the ToolCardData its result was folded into. */
type ConversationItem =
  | { key: string; kind: "task"; text: string }
  | { key: string; kind: "assistant"; text: string }
  | { key: string; kind: "reasoning"; text: string }
  | { key: string; kind: "tool"; name: string; card: ToolCardData };

/**
 * The structured transcript (FR-037) rendered with the live chat's own
 * components (FR-031). tool_call/tool_result entries pair by callId into one
 * ToolCallCard; `live` decides what an unanswered call means — still running
 * (spinner) on an in-flight run, merely done-without-a-record on a finished one.
 */
function ConversationView({
  runId,
  entries,
  live,
  stuckTool,
}: {
  runId: string;
  entries: TranscriptEntry[];
  live: boolean;
  stuckTool?: string;
}) {
  const items = useMemo<ConversationItem[]>(() => {
    const results = new Map<string, Extract<TranscriptEntry, { type: "tool_result" }>>();
    for (const e of entries) if (e.type === "tool_result") results.set(e.callId, e);
    return entries.flatMap((e, i): ConversationItem[] => {
      if (e.type === "tool_result") return [];
      if (e.type === "task_input") return [{ key: `task-${i}`, kind: "task", text: e.text }];
      if (e.type === "assistant_text") return [{ key: `assistant-${i}`, kind: "assistant", text: e.text }];
      if (e.type === "reasoning") return [{ key: `reasoning-${i}`, kind: "reasoning", text: e.text }];
      const result = results.get(e.callId);
      return [
        {
          key: `tool-${e.callId}-${i}`,
          kind: "tool",
          name: e.name,
          card: {
            callId: e.callId,
            name: e.name,
            args: typeof e.args === "string" ? e.args : JSON.stringify(e.args ?? {}),
            status: !result && live ? "running" : "done",
            ...(result ? { result: result.result } : {}),
          },
        },
      ];
    });
  }, [entries, live]);

  return (
    // Own collapse scope, keyed by run: the cards must not share open/closed
    // state with the Assistant chat's scope (or another run's).
    <CardScopeProvider scope={`selfheal-transcript:${runId}`}>
      <div className="max-h-96 overflow-auto pr-1 text-left" data-testid="self-heal-transcript-conversation">
        {items.map((item) => {
          if (item.kind === "task") {
            return (
              <div key={item.key} className="mb-2 rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-2">
                <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-white/35">Task</div>
                <ChatMarkdown content={item.text} />
              </div>
            );
          }
          if (item.kind === "reasoning") {
            return (
              <details key={item.key} className="mb-2 overflow-hidden rounded-lg border border-white/10 bg-white/[0.03]">
                <summary className="flex cursor-pointer select-none items-center gap-1.5 px-2.5 py-1.5 text-xs text-white/55">
                  <Brain size={13} className="text-white/40" aria-hidden />
                  Reasoning
                </summary>
                <div className="max-h-64 overflow-auto px-3 pb-2.5 pt-1 text-[11px] leading-relaxed text-white/45">
                  <ChatMarkdown content={item.text} />
                </div>
              </details>
            );
          }
          if (item.kind === "assistant") {
            return (
              <div key={item.key} className="mb-2">
                <ChatMarkdown content={item.text} />
              </div>
            );
          }
          return (
            <div key={item.key} className={stuckTool === item.name ? "rounded-lg ring-1 ring-amber-400/40" : undefined}>
              <ToolCallCard call={item.card} />
            </div>
          );
        })}
      </div>
    </CardScopeProvider>
  );
}

/** Markdown fallback for a run recorded before the structured companion
 *  existed (pre-FR-037). Highlights the lines the stuck detector was
 *  complaining about, so "repeated `file_search` ×5" is something the user can
 *  SEE in the transcript rather than take on trust. Matches on the tool name
 *  only: the transcript renders raw JSON input while the signature holds the
 *  normalized form. */
function TranscriptBody({ markdown, stuckTool }: { markdown: string; stuckTool?: string }) {
  const lines = useMemo(() => markdown.split("\n"), [markdown]);
  if (!stuckTool) {
    return (
      <pre className="max-h-80 overflow-auto whitespace-pre-wrap font-mono text-[10px] leading-relaxed text-white/75">
        {markdown}
      </pre>
    );
  }
  return (
    <pre className="max-h-80 overflow-auto whitespace-pre-wrap font-mono text-[10px] leading-relaxed text-white/75">
      {lines.map((line, i) => (
        <span key={i} className={line.includes(`\`${stuckTool}\``) ? "text-amber-300" : undefined}>
          {line}
          {"\n"}
        </span>
      ))}
    </pre>
  );
}

export function TranscriptsSection({ record }: { record: HealingCase }) {
  const runs = record.runs ?? [];
  // The selection is stored WITH the case it belongs to, so opening another
  // case falls back to that case's default instead of asking for a runId from
  // the previous one — a derived value rather than a reset effect.
  const [selected, setSelected] = useState<{ caseId: string; runId: string } | null>(null);
  const picked = selected?.caseId === record.id ? selected.runId : undefined;
  const runId = picked && runs.some((r) => r.runId === picked) ? picked : defaultRunId(runs);
  const selectedRun = runs.find((r) => r.runId === runId);
  // A run still in flight is being appended to, so its transcript is re-read on
  // a short poll — that is all "live" needs to mean here (FR-031).
  const { transcript, entries, found, loading } = useRunTranscript(runId, selectedRun?.status === "in-flight");

  return (
    <div className={CARD} data-testid="self-heal-transcripts">
      <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-violet-300">Transcripts</div>
      {runs.length === 0 ? (
        <p className="text-[11px] text-white/40" data-testid="self-heal-transcripts-empty">
          No headless runs yet. Each run this case starts — the Diagnostician, then the fix pipeline — is listed here
          with its own transcript.
        </p>
      ) : (
        <>
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="border-b border-white/10 text-[10px] uppercase tracking-wide text-white/35">
                <th className="py-1.5 pr-3 font-semibold">Agent</th>
                <th className="py-1.5 pr-3 font-semibold">Run id</th>
                <th className="py-1.5 pr-3 font-semibold">Status</th>
                <th className="py-1.5 font-semibold" />
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.runId} className="border-b border-white/5 align-top" data-testid={`self-heal-run-${run.runId}`}>
                  <td className="py-2 pr-3 text-[11px] font-semibold whitespace-nowrap text-white">
                    {ROLE_LABEL[run.role]}
                    <span className="ml-1.5 font-normal text-white/40">{run.agentName ?? run.agentId}</span>
                  </td>
                  <td className="max-w-[28ch] truncate py-2 pr-3 font-mono text-[10px] text-white/55">{run.runId}</td>
                  <td className="py-2 pr-3 text-[11px] whitespace-nowrap">
                    <span className={`inline-flex items-center gap-1.5 ${RUN_STATUS_TONE[run.status]}`}>
                      {run.status === "in-flight" ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : null}
                      {RUN_STATUS_LABEL[run.status]}
                    </span>
                    {run.status === "in-flight" ? (
                      <span className="ml-1.5 rounded-full border border-emerald-400/30 bg-emerald-400/10 px-1.5 text-[9px] font-bold tracking-wide text-emerald-300">
                        live
                      </span>
                    ) : null}
                  </td>
                  <td className="py-2 text-right">
                    <button
                      type="button"
                      data-testid={`self-heal-view-transcript-${run.runId}`}
                      onClick={() => setSelected({ caseId: record.id, runId: run.runId })}
                      className={`rounded border px-2 py-0.5 text-[10px] font-medium transition-colors ${
                        run.runId === runId
                          ? "border-violet-400/40 bg-violet-500/20 text-violet-100"
                          : "border-white/15 bg-white/5 text-white/70 hover:bg-white/10"
                      }`}
                    >
                      View transcript
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {selectedRun ? (
            <div className="mt-2.5" data-testid="self-heal-transcript-panel">
              <div className="mb-1 text-[10px] text-white/40">
                Rendering · {ROLE_LABEL[selectedRun.role]} run
                {selectedRun.status === "in-flight" ? " (in-flight — appending live)" : ""}
              </div>
              {loading && !transcript && !entries ? (
                <p className="text-[11px] text-white/40">Loading transcript…</p>
              ) : found && entries ? (
                <ConversationView
                  runId={selectedRun.runId}
                  entries={entries}
                  live={selectedRun.status === "in-flight"}
                  {...(record.stuckSignature?.runId === selectedRun.runId && record.stuckSignature.tool
                    ? { stuckTool: record.stuckSignature.tool }
                    : {})}
                />
              ) : found ? (
                <TranscriptBody
                  markdown={transcript}
                  {...(record.stuckSignature?.runId === selectedRun.runId && record.stuckSignature.tool
                    ? { stuckTool: record.stuckSignature.tool }
                    : {})}
                />
              ) : (
                <p className="text-[11px] text-white/40" data-testid="self-heal-transcript-missing">
                  No transcription for this run. Turn on Settings → Agent Runs → “Record run transcripts” to record
                  future runs.
                </p>
              )}
              <p className="mt-1 text-[10px] text-white/30">
                One file per run ·{" "}
                <code className="font-mono">data/agent-transcripts/{selectedRun.agentId}/{selectedRun.runId}.md</code>
              </p>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
