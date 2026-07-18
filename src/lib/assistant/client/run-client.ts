"use client";

// RunClient — the browser side of server-owned runs and the programmatic embed
// API. Responsibilities:
//   - start / stop runs over the runs HTTP API;
//   - attach to a run's NDJSON event stream (replay + live), reconnect with
//     ?since= after network drops;
//   - execute FRONTEND tool dispatches through the existing tool kernel
//     (timeouts, in-band errors, settle guarantees) and post the result back —
//     first claim wins, so N tabs never double-execute;
//   - feed every event into the chat store projection.
//
// Handlers are registered by name: global frontend tools once at app start,
// surface tools per mounted embed (register/unregister with the component).

import { runToolHandler } from "@/lib/agent/tool-kernel";
import { maybeGenerateTitleInBackground } from "@/lib/agent/conversations";
import type { ChatMessage, Attachment } from "../messages";
import type { RunEvent } from "../run-events";
import type { ToolDeclaration } from "../tools";
import { applyRunEvent, getChatState, markRunStarting, setHistory, stampFeedbackLocal } from "./chat-store";
import {
  findSurfaceToolHandler,
  getActiveSurfaceToolDeclarations,
  onSurfaceToolsChanged,
  type FrontendToolHandler,
} from "./surface-tools";
import { getActiveSurfaceAgents, onSurfaceAgentsChanged, type SurfaceAgentEntry } from "./surface-agents";

export type { FrontendToolHandler };

const handlers = new Map<string, FrontendToolHandler>();
const attached = new Set<string>(); // runIds with a live reader in THIS page

async function pushSurfaceTools(runId: string, declarations: ToolDeclaration[]): Promise<void> {
  await fetch(`/api/assistant/runs/${encodeURIComponent(runId)}/surface-tools`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ declarations }),
  }).catch(() => undefined);
}

// A window can open (and register its Tier 2 surface tools) DURING an active
// run — e.g. the agent calls ui_preview_open then wants ui_preview_generate in
// the same turn. surfaceTools is otherwise only read once, when a run starts,
// so without this the new tools wouldn't be callable until the conversation's
// NEXT run. Skip the push if the name set is unchanged (Build Studio
// re-registers on most content changes, not just window open/close).
// Window mount/unmount effects can fire several notifyChanged() calls back to
// back (e.g. React dev-mode double-invoke, or two windows registering within
// the same tick), racing the dispatch chain's own flush call below. A caller
// whose key matches one already "claimed" must await THAT push's promise, not
// return immediately — otherwise dispatchFrontendCall could post a tool's
// result (unblocking the server loop) before the matching push has actually
// reached the server, which is the one guarantee this function exists to give.
let lastPushedSurfaceToolsKey = "";
let lastPushPromise: Promise<void> = Promise.resolve();
async function flushSurfaceTools(runId: string): Promise<void> {
  const declarations = getActiveSurfaceToolDeclarations();
  const key = declarations.map((d) => d.name).sort().join(",");
  if (key === lastPushedSurfaceToolsKey) {
    await lastPushPromise;
    return;
  }
  lastPushedSurfaceToolsKey = key;
  lastPushPromise = pushSurfaceTools(runId, declarations);
  await lastPushPromise;
}

async function pushSurfaceAgents(runId: string, agents: SurfaceAgentEntry[]): Promise<void> {
  await fetch(`/api/assistant/runs/${encodeURIComponent(runId)}/surface-agents`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agents }),
  }).catch(() => undefined);
}

// Mirrors flushSurfaceTools exactly (025-agent-delegation-v2, FR-010's
// "live-pushed mid-run"): a window can register its surface agent DURING an
// active run (e.g. ui_preview_open mounts UI Preview, which also registers
// its "Generative UI Agent"), so without this the new agent wouldn't be
// delegatable until the conversation's NEXT run.
let lastPushedSurfaceAgentsKey = "";
let lastAgentsPushPromise: Promise<void> = Promise.resolve();
async function flushSurfaceAgents(runId: string): Promise<void> {
  const agents = getActiveSurfaceAgents();
  const key = agents
    .map((a) => a.id)
    .sort()
    .join(",");
  if (key === lastPushedSurfaceAgentsKey) {
    await lastAgentsPushPromise;
    return;
  }
  lastPushedSurfaceAgentsKey = key;
  lastAgentsPushPromise = pushSurfaceAgents(runId, agents);
  await lastAgentsPushPromise;
}

// Background path: something registers/unregisters surface tools with no
// tool call in flight (e.g. the user closes a window by hand mid-run).
onSurfaceToolsChanged(() => {
  for (const runId of attached) void flushSurfaceTools(runId);
});
onSurfaceAgentsChanged(() => {
  for (const runId of attached) void flushSurfaceAgents(runId);
});

export function registerFrontendTool(name: string, handler: FrontendToolHandler): () => void {
  handlers.set(name, handler);
  return () => {
    if (handlers.get(name) === handler) handlers.delete(name);
  };
}

async function postToolResult(runId: string, callId: string, result: string): Promise<void> {
  await fetch(`/api/assistant/runs/${encodeURIComponent(runId)}/tool-results`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ callId, result }),
  }).catch(() => undefined);
}

function dispatchFrontendCall(runId: string, e: Extract<RunEvent, { type: "tool_call" }>) {
  const handler = handlers.get(e.name) ?? findSurfaceToolHandler(e.name);
  if (!handler) return; // another surface may claim it; server times out in-band
  let input: Record<string, unknown> = {};
  try {
    input = e.args ? (JSON.parse(e.args) as Record<string, unknown>) : {};
  } catch {
    /* tool reports its own validation error */
  }
  void runToolHandler(e.name, ({ signal }) => handler(input, { signal })).then(async (result) => {
    // Give a window this call may have just opened a couple of paints to
    // mount and register its surface tools, THEN sync — and post the tool's
    // own result only after that sync lands. Otherwise a tool that opens a
    // window (e.g. ui_preview_open) reports its result — unblocking the loop
    // for the next step — before the server ever learns the new window's
    // tools exist, and the very next step can't call them.
    await new Promise((r) => requestAnimationFrame(r));
    await new Promise((r) => requestAnimationFrame(r));
    await flushSurfaceTools(runId);
    await flushSurfaceAgents(runId);
    await postToolResult(runId, e.callId, result);
  });
}

/** Attach to a run's event stream and pump events into the store. Reconnects
 *  (with ?since=) while the run is still live; returns when run_finished (or
 *  the run is unknown/expired). Idempotent per page+run. */
export async function attachToRun(conversationId: string, runId: string): Promise<void> {
  if (attached.has(runId)) return;
  attached.add(runId);
  try {
    for (;;) {
      const since = getChatState(conversationId).runId === runId ? getChatState(conversationId).lastSeq : 0;
      let finished = false;
      let sawEvent = false;
      try {
        const res = await fetch(`/api/assistant/runs/${encodeURIComponent(runId)}/events?since=${since}`);
        if (res.status === 404) return; // expired from retention — history has the truth
        if (!res.ok || !res.body) throw new Error(`events stream: HTTP ${res.status}`);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            let event: RunEvent;
            try {
              event = JSON.parse(line) as RunEvent;
            } catch {
              continue;
            }
            sawEvent = true;
            applyRunEvent(conversationId, event);
            if (event.type === "tool_call" && event.execution === "frontend") {
              dispatchFrontendCall(runId, event);
            }
            if (event.type === "run_finished") {
              finished = true;
              // Client-driven auto-titling: on a completed first exchange, name a
              // still-"New conversation" from its transcript. renameConversation
              // updates the sidebar store live (the server is the transcript
              // writer, so nothing else refreshes the title here).
              if (event.reason === "completed") {
                void maybeGenerateTitleInBackground(conversationId, getChatState(conversationId).messages);
              }
            }
          }
        }
      } catch {
        /* network drop — retry below */
      }
      if (finished) return;
      // Stream ended without run_finished: transient drop or server restart.
      // Back off briefly and re-attach from the last seen seq.
      await new Promise((r) => setTimeout(r, sawEvent ? 500 : 2000));
      const probe = await fetch(`/api/assistant/runs?conversationId=${encodeURIComponent(conversationId)}`)
        .then((r) => r.json())
        .catch(() => undefined);
      if (!probe || probe.runId !== runId) return; // run is gone; nothing to tail
    }
  } finally {
    attached.delete(runId);
  }
}

/** Load the persisted transcript into the store (server-sanitized). */
export async function loadHistory(conversationId: string): Promise<void> {
  const res = await fetch(`/api/assistant/conversations/${encodeURIComponent(conversationId)}/messages`).catch(
    () => undefined,
  );
  const data = res?.ok ? ((await res.json()) as { messages?: ChatMessage[] }) : undefined;
  setHistory(conversationId, Array.isArray(data?.messages) ? data!.messages! : []);
}

/** Open a conversation: load history and re-attach to its active run, if any. */
export async function openConversation(conversationId: string): Promise<void> {
  await loadHistory(conversationId);
  const probe = await fetch(`/api/assistant/runs?conversationId=${encodeURIComponent(conversationId)}`)
    .then((r) => r.json())
    .catch(() => undefined);
  if (probe?.runId) {
    markRunStarting(conversationId, probe.runId);
    void attachToRun(conversationId, probe.runId);
  }
}

export interface SendOptions {
  editOfMessageId?: string;
  surfaceTools?: ToolDeclaration[];
  attachments?: Attachment[];
}

/** Start a run for a user message (or an edit-resubmit). Resolves once the
 *  run is started and this page is attached; the run itself is server-owned. */
export async function sendMessage(
  conversationId: string,
  agentId: string,
  message: string,
  opts?: SendOptions,
): Promise<{ ok: true } | { ok: false; error: string }> {
  // Every currently-open app window contributes its surface tools automatically
  // (013-build-studio-agentic V2); `opts.surfaceTools` remains for a caller that
  // wants to add ad-hoc declarations without registering a window.
  const byName = new Map(getActiveSurfaceToolDeclarations().map((d) => [d.name, d]));
  for (const d of opts?.surfaceTools ?? []) byName.set(d.name, d);
  const surfaceTools = [...byName.values()];
  // Every currently-open app window's surface agent rides on the run start the
  // same way (025-agent-delegation-v2); mid-run registrations are covered by
  // flushSurfaceAgents above.
  const surfaceAgents = getActiveSurfaceAgents();

  const res = await fetch("/api/assistant/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      conversationId,
      agentId,
      message,
      editOfMessageId: opts?.editOfMessageId,
      surfaceTools: surfaceTools.length ? surfaceTools : undefined,
      surfaceAgents: surfaceAgents.length ? surfaceAgents : undefined,
      attachments: opts?.attachments,
    }),
  }).catch((e) => ({ ok: false, status: 0, json: async () => ({ error: (e as Error).message }) }) as unknown as Response);
  const data = (await res.json().catch(() => ({}))) as { runId?: string; error?: string };
  if (!res.ok || !data.runId) {
    return { ok: false, error: data.error ?? `HTTP ${res.status}` };
  }
  markRunStarting(conversationId, data.runId);
  void attachToRun(conversationId, data.runId);
  return { ok: true };
}

/** Server-side stop for the conversation's active run. */
export async function stopRun(conversationId: string): Promise<void> {
  const runId = getChatState(conversationId).runId;
  if (!runId) return;
  await fetch(`/api/assistant/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST" }).catch(() => undefined);
}

/** Thumbs feedback: optimistic local stamp + server persistence (the client no
 *  longer writes the transcript). */
export async function sendFeedback(conversationId: string, messageId: string, rating: "up" | "down"): Promise<void> {
  stampFeedbackLocal(conversationId, messageId, rating);
  await fetch(`/api/assistant/conversations/${encodeURIComponent(conversationId)}/messages`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messageId, feedback: { rating, at: Date.now() } }),
  }).catch(() => undefined);
}

/** Delete the last turn (last user message + its responses). Server-owned
 *  transcript, so the server truncates and we reload the resulting history.
 *  Returns false if a run is active (the server rejects it with 409). */
export async function deleteLastTurn(conversationId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await fetch(`/api/assistant/conversations/${encodeURIComponent(conversationId)}/messages`, {
    method: "DELETE",
  }).catch(() => undefined);
  if (!res) return { ok: false, error: "Network error" };
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: data.error ?? `HTTP ${res.status}` };
  }
  const data = (await res.json()) as { messages?: ChatMessage[] };
  setHistory(conversationId, Array.isArray(data.messages) ? data.messages : []);
  return { ok: true };
}
