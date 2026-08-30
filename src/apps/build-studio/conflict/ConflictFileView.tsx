"use client";

import { useState } from "react";
import { AlertTriangle, Check, FileText, Loader2, Timer, X } from "lucide-react";
import type { ConflictFileState, ConflictSession } from "@/lib/gitops/sessions/types";
import { ConflictDecisionCard, type DecisionOptionId } from "./ConflictDecisionCard";
import { useThreeWay } from "./useConflictSession";
import { baseName } from "./status";

// The 3-way file view (FR-008, mockup `.detail`): a unified marker rendering
// with per-hunk decision controls, a 3-way column mode for code, and a
// side-by-side comparison for text. The base side is rendered as "(empty)"
// for an add/add — the file genuinely does not exist at the merge base, which
// is the shape of the reported repro.

interface Props {
  session: ConflictSession;
  path: string | undefined;
  busy: boolean;
  onAnswer: (optionId: DecisionOptionId, manualText?: string) => void;
}

export function ConflictFileView({ session, path, busy, onAnswer }: Props) {
  const [viewMode, setViewMode] = useState<"unified" | "columns">("unified");
  const { file, loading, error } = useThreeWay(session.id, path);
  const state: ConflictFileState | undefined = session.files.find((f) => f.path === path);

  if (!path) {
    return (
      <div className="flex flex-1 items-center justify-center text-[12px] text-white/30">
        Select a conflicting file to see its three-way view.
      </div>
    );
  }

  const resolved = state?.resolvedContent !== undefined;
  const awaitingThis = session.status === "awaiting-user" && session.pendingDecision?.path === path;

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center gap-2.5 border-b border-white/10 px-3.5 py-2">
        <FileText size={13} className="shrink-0 text-white/30" />
        <span className="truncate font-mono text-[12px] text-white/75">{path}</span>
        {!file?.binary && (
          <div className="ml-auto flex shrink-0 gap-0.5 rounded-md border border-white/10 bg-black/30 p-0.5">
            {(["unified", "columns"] as const).map((m) => (
              <button
                key={m}
                onClick={() => setViewMode(m)}
                className={`rounded px-2 py-0.5 text-[10px] ${
                  viewMode === m ? "bg-white/10 text-white/80" : "text-white/45 hover:text-white/70"
                }`}
              >
                {m === "unified" ? "Unified · markers" : "3-way columns"}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="flex-1 overflow-auto px-3.5 py-3">
        <Banner session={session} path={path} resolved={resolved} awaitingThis={awaitingThis} />

        {loading && (
          <p className="flex items-center gap-2 text-[11px] text-white/40">
            <Loader2 size={12} className="animate-spin" /> Reading the three-way content…
          </p>
        )}
        {error && <p className="rounded border border-red-400/35 bg-red-500/10 p-2 text-[11px] text-red-300">{error}</p>}

        {file && (
          <>
            <div className="mb-2.5 rounded-md border border-dashed border-white/10 px-2.5 py-1.5 text-[10.5px] italic text-white/30">
              {file.base === null
                ? "base: (empty) — the file does not exist at the merge base (add/add)"
                : `base: merge-base ${session.snapshot.base.slice(0, 10)} · conflict kind: ${file.conflict}`}
            </div>

            {file.binary ? (
              <div className="rounded-md border border-red-400/40 bg-red-500/10 p-3 text-[11.5px] text-red-200">
                <b>Binary file.</b> This cannot be merged as text and the agent will never write one. It needs manual
                handling — roll back with <code className="rounded bg-black/30 px-1">{session.rollbackTag}</code> and
                resolve it outside BOS, or accept one whole side.
              </div>
            ) : viewMode === "columns" ? (
              <ThreeWayColumns session={session} file={file} />
            ) : (
              <UnifiedMarkers markers={file.markers} resolvedContent={state?.resolvedContent} />
            )}
          </>
        )}
      </div>

      {resolved ? (
        <div className="shrink-0 border-t border-white/10 px-3.5 py-2.5">
          <span className="flex items-center gap-2 text-[11px] text-emerald-300">
            <Check size={12} />
            Resolved by {state?.resolvedBy ?? "agent"} — markers removed, ready to commit
          </span>
        </div>
      ) : (
        <div className="shrink-0">
          <ConflictDecisionCard
            session={session}
            file={file}
            path={path}
            answerable={awaitingThis}
            busy={busy}
            onAnswer={onAnswer}
          />
        </div>
      )}
    </div>
  );
}

/** The full-width banner over the file view — the second of D6's four
 *  awaiting-user surfaces, and the place a terminal state explains itself. */
function Banner({
  session,
  path,
  resolved,
  awaitingThis,
}: {
  session: ConflictSession;
  path: string;
  resolved: boolean;
  awaitingThis: boolean;
}) {
  if (session.status === "awaiting-user") {
    if (awaitingThis) {
      return (
        <Box tone="amber" icon={<AlertTriangle size={15} />} title={`The agent is waiting on you for ${baseName(path)}`}>
          {session.pendingDecision?.question}
        </Box>
      );
    }
    return (
      <Box tone="amber" icon={<AlertTriangle size={15} />} title="Agent waiting on you — but for a different file">
        Select the amber file in the list to answer. This file is currently{" "}
        <b>{resolved ? "resolved" : "waiting on the agent"}</b>.
      </Box>
    );
  }
  if (session.status === "failed" || session.status === "abandoned") {
    return (
      <Box tone="red" icon={<X size={15} />} title={session.status === "abandoned" ? "Rolled back" : "The agent could not resolve this"}>
        {session.result?.error ?? session.result?.reason ?? "The resolution did not complete."} The repo was restored to{" "}
        <code className="rounded bg-black/30 px-1">{session.rollbackTag}</code> — base was never left conflicted.
      </Box>
    );
  }
  if (session.status === "timed-out") {
    return (
      <Box tone="red" icon={<Timer size={15} />} title="Agent timed out after 25 minutes">
        The working phase exceeded its budget. The session is terminal — the repo was rolled back via{" "}
        <code className="rounded bg-black/30 px-1">{session.rollbackTag}</code>.
      </Box>
    );
  }
  if (session.status === "resolved") {
    return (
      <Box tone="emerald" icon={<Check size={15} />} title="All conflicts resolved">
        The <b>{session.operationLabel}</b> completed. Rollback tag{" "}
        <code className="rounded bg-black/30 px-1">{session.rollbackTag}</code> is retained until you&rsquo;re sure.
      </Box>
    );
  }
  return null;
}

function Box({
  tone,
  icon,
  title,
  children,
}: {
  tone: "amber" | "red" | "emerald";
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  const cls =
    tone === "amber"
      ? "border-amber-400/45 bg-amber-500/12 text-amber-300"
      : tone === "red"
        ? "border-red-400/45 bg-red-500/12 text-red-300"
        : "border-emerald-400/40 bg-emerald-500/12 text-emerald-300";
  return (
    <div data-testid="conflict-banner" className={`mb-3 flex items-start gap-2.5 rounded-lg border px-3 py-2.5 ${cls}`}>
      <span className="mt-px shrink-0">{icon}</span>
      <div className="min-w-0">
        <div className="text-[12px] font-bold">{title}</div>
        <div className="mt-0.5 text-[11px] text-white/75">{children}</div>
      </div>
    </div>
  );
}

/** Unified rendering with real conflict markers — produced server-side by
 *  `git merge-file --diff3` over the three ref contents, so it looks exactly
 *  like the conflicted file would have, even though the merge was aborted. */
function UnifiedMarkers({ markers, resolvedContent }: { markers: string | null; resolvedContent?: string }) {
  const body = resolvedContent ?? markers;
  if (!body) return <p className="text-[11px] italic text-white/30">No content to display.</p>;
  const lines = body.split("\n");
  return (
    <div data-testid="conflict-unified" className="rounded-lg border border-white/10 bg-white/[0.02] font-mono text-[11.5px] leading-[1.55]">
      {lines.map((line, i) => {
        const side = line.startsWith("<<<<<<<")
          ? "text-red-300/80"
          : line.startsWith(">>>>>>>")
            ? "text-sky-300/80"
            : line.startsWith("=======") || line.startsWith("|||||||")
              ? "text-white/30"
              : "text-white/70";
        return (
          <div key={i} className="flex whitespace-pre-wrap break-words">
            <span className="w-9 shrink-0 select-none pr-2.5 text-right text-white/15">{i + 1}</span>
            <span className={side}>{line}</span>
          </div>
        );
      })}
    </div>
  );
}

function ThreeWayColumns({ session, file }: { session: ConflictSession; file: { base: string | null; ours: string | null; theirs: string | null } }) {
  return (
    <div data-testid="conflict-columns" className="grid grid-cols-3 overflow-hidden rounded-lg border border-white/10">
      <Column title={`ours · ${session.baseBranch || session.snapshot.ours}`} tone="text-red-300" body={file.ours} />
      <Column title="base · merge-base" tone="text-white/35" body={file.base} bordered />
      <Column title={`theirs · ${session.featureBranch || session.snapshot.theirs}`} tone="text-sky-300" body={file.theirs} bordered />
    </div>
  );
}

function Column({ title, tone, body, bordered }: { title: string; tone: string; body: string | null; bordered?: boolean }) {
  return (
    <div className={`flex min-w-0 flex-col ${bordered ? "border-l border-white/10" : ""}`}>
      <div className={`border-b border-white/10 bg-white/[0.03] px-2.5 py-1.5 text-[10px] font-bold ${tone}`}>{title}</div>
      <div className="max-h-[420px] overflow-auto py-1.5">
        {body === null ? (
          <p className="px-3 py-3 text-[11px] italic text-white/30">(empty — file added on both branches)</p>
        ) : (
          body.split("\n").map((line, i) => (
            <div key={i} className="flex whitespace-pre-wrap break-words pr-2.5">
              <span className="w-9 shrink-0 select-none pr-2.5 text-right font-mono text-white/15">{i + 1}</span>
              <span className="font-mono text-[11.5px] text-white/70">{line}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
