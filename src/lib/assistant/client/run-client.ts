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
import type { ChatMessage, Attachment } from "../messages";
import type { RunEvent } from "../run-events";
import type { ToolDeclaration } from "../tools";
import { applyRunEvent, getChatState, markRunStarting, setHistory, stampFeedbackLocal } from "./chat-store";

export type FrontendToolHandler = (
  input: Record<string, unknown>,
  ctx: { signal: AbortSignal },
) => Promise<unknown>;

const handlers = new Map<string, FrontendToolHandler>();
const attached = new Set<string>(); // runIds with a live reader in THIS page

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
  const handler = handlers.get(e.name);
  if (!handler) return; // another surface may claim it; server times out in-band
  let input: Record<string, unknown> = {};
  try {
    input = e.args ? (JSON.parse(e.args) as Record<string, unknown>) : {};
  } catch {
    /* tool reports its own validation error */
  }
  void runToolHandler(e.name, ({ signal }) => handler(input, { signal })).then((result) =>
    postToolResult(runId, e.callId, result),
  );
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
            if (event.type === "run_finished") finished = true;
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
  const res = await fetch("/api/assistant/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      conversationId,
      agentId,
      message,
      editOfMessageId: opts?.editOfMessageId,
      surfaceTools: opts?.surfaceTools,
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
