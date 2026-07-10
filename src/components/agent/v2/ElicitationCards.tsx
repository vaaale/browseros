"use client";

import { useState } from "react";
import { useElicitations, type PendingElicitation } from "@/lib/assistant/client/elicitations";
import { setConversationActiveFeatureBranch, useActiveConversation } from "@/lib/agent/conversations";
import { suggestFeatureBranchName, normalizeFeatureBranch } from "@/lib/agent/feature-branch";

// v2 elicitation cards — replaces CopilotKit's renderAndWaitForResponse. Cards
// render at the transcript tail for pending elicitations; a click resolves the
// awaiting frontend-tool handler, whose string goes back to the server loop.

// Claude-agent permission, remembered per page session.
let claudeSessionGranted = false;

function ClaudeConsentCard({ e }: { e: PendingElicitation }) {
  if (claudeSessionGranted) {
    return (
      <div className="my-1 rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-xs">
        <div className="mb-2 text-white/70">Claude agent permission already granted for this session.</div>
        <button onClick={() => e.resolve("session")} className="rounded bg-amber-400/20 px-2.5 py-1 font-medium hover:bg-amber-400/30">
          Continue
        </button>
      </div>
    );
  }
  const pick = (c: "once" | "session" | "local") => {
    if (c === "session") claudeSessionGranted = true;
    e.resolve(c);
  };
  return (
    <div className="my-1 rounded-lg border border-amber-400/30 bg-amber-400/10 p-3 text-xs" data-testid="claude-consent-card">
      <div className="mb-2 text-amber-100">
        The assistant wants to use a <b>Claude agent</b> for a non-development task:
        <div className="mt-1 text-white/70">{String(e.input.task ?? "")}</div>
      </div>
      <div className="flex flex-wrap gap-2">
        <button onClick={() => pick("once")} className="rounded bg-amber-400/20 px-2.5 py-1 font-medium hover:bg-amber-400/30">Allow Claude once</button>
        <button onClick={() => pick("session")} className="rounded bg-amber-400/20 px-2.5 py-1 font-medium hover:bg-amber-400/30">Allow this session</button>
        <button onClick={() => pick("local")} className="rounded bg-white/10 px-2.5 py-1 font-medium hover:bg-white/20">Use Local</button>
      </div>
    </div>
  );
}

function FeatureBranchCard({ e, existingBranch }: { e: PendingElicitation; existingBranch?: string }) {
  const task = String(e.input.task ?? "");
  const suggested = typeof e.input.suggestedBranch === "string" ? e.input.suggestedBranch : undefined;
  const [name, setName] = useState(() => {
    if (suggested) {
      const normalized = normalizeFeatureBranch(suggested);
      if (normalized) return normalized.replace(/^bos\//, "");
    }
    return suggestFeatureBranchName(task).replace(/^bos\//, "");
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  if (existingBranch) {
    return (
      <div className="my-1 rounded-lg border border-sky-400/30 bg-sky-400/10 p-3 text-xs">
        <div className="mb-2 text-sky-100">
          This conversation already targets feature branch <b>{existingBranch}</b> — no new branch needed.
        </div>
        <button
          onClick={() =>
            e.resolve(
              `Active feature branch is already "${existingBranch}". Do NOT create a new one — delegate the source change to the "developer" sub-agent now.`,
            )
          }
          className="rounded bg-sky-400/20 px-2.5 py-1 font-medium hover:bg-sky-400/30"
        >
          Continue with {existingBranch}
        </button>
      </div>
    );
  }

  const create = async () => {
    setBusy(true);
    setErr("");
    const res = await fetch("/api/assistant/feature-branches", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    })
      .then((r) => r.json())
      .catch(() => null);
    if (!res?.ok || typeof res.branch !== "string") {
      setErr(res?.error ?? "Could not create feature branch.");
      setBusy(false);
      return;
    }
    if (e.conversationId) await setConversationActiveFeatureBranch(e.conversationId, res.branch);
    e.resolve(`Active feature branch set to "${res.branch}". Now delegate the source change to the developer sub-agent.`);
  };

  return (
    <div className="my-1 rounded-lg border border-sky-400/30 bg-sky-400/10 p-3 text-xs" data-testid="branch-card">
      <div className="mb-2 text-sky-100">
        This change edits BrowserOS itself, which needs a <b>feature branch</b>. Name it (or accept the suggestion):
      </div>
      <div className="mb-2 flex items-center gap-1.5">
        <span className="text-white/50">bos/</span>
        <input
          value={name}
          onChange={(ev) => setName(ev.target.value)}
          disabled={busy}
          className="min-w-0 flex-1 rounded border border-white/10 bg-black/30 px-2 py-1 text-white/90 outline-none focus:border-white/30"
          placeholder="my-change"
        />
      </div>
      {err && <div className="mb-2 text-red-300">{err}</div>}
      <div className="flex flex-wrap gap-2">
        <button
          onClick={create}
          disabled={busy || !name.trim()}
          className="rounded bg-sky-400/20 px-2.5 py-1 font-medium hover:bg-sky-400/30 disabled:opacity-50"
        >
          {busy ? "Creating…" : "Create & continue"}
        </button>
        <button
          onClick={() => e.resolve("User cancelled feature-branch creation. Do not delegate the source change.")}
          disabled={busy}
          className="rounded bg-white/10 px-2.5 py-1 font-medium hover:bg-white/20 disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

export function ElicitationCards({ conversationId, agentId }: { conversationId: string; agentId: string }) {
  const pending = useElicitations(conversationId);
  const activeConversation = useActiveConversation(agentId);
  if (pending.length === 0) return null;
  return (
    <>
      {pending.map((e) =>
        e.tool === "agent_request_claude" ? (
          <ClaudeConsentCard key={e.id} e={e} />
        ) : e.tool === "dev_branch_request" ? (
          <FeatureBranchCard key={e.id} e={e} existingBranch={activeConversation?.activeFeatureBranch} />
        ) : null,
      )}
    </>
  );
}
