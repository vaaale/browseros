import "server-only";
import type { StreamTurn, TurnResult } from "./agent-loop";

// Test-only scripted provider (Milestone E). Enabled ONLY when
// BOS_E2E_SCRIPTED=1 AND the user message begins with an `@@e2e ` directive
// carrying a JSON script. This lets browser e2e tests drive the server-owned
// run deterministically (the model call is server-side and can't be intercepted
// from the page, unlike the retired CopilotKit path). No effect in production.
//
// Directive: `@@e2e {"turns":[{ "text": "...", "deltas": 6, "delayMs": 80,
//   "tools":[{"name":"bos_app_list","args":{}}] }, ...]}`
// Each turn streams `text` as `deltas` chunks with `delayMs` between them
// (abortable), then returns its tool calls. Turns are consumed across loop
// steps in order.

interface ScriptTurn {
  text?: string;
  deltas?: number;
  delayMs?: number;
  tools?: { name: string; args?: unknown }[];
}

const PREFIX = "@@e2e ";

function parseScript(message: string): ScriptTurn[] | null {
  if (process.env.BOS_E2E_SCRIPTED !== "1") return null;
  if (!message.startsWith(PREFIX)) return null;
  try {
    const parsed = JSON.parse(message.slice(PREFIX.length)) as { turns?: ScriptTurn[] };
    return Array.isArray(parsed.turns) ? parsed.turns : null;
  } catch {
    return null;
  }
}

function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/** Returns a scripted StreamTurn when the run is an e2e-scripted one, else null
 *  (the caller falls back to the real provider). */
export function e2eScriptedTurn(message: string): StreamTurn | null {
  const turns = parseScript(message);
  if (!turns) return null;
  let i = 0;
  return async (opts): Promise<TurnResult> => {
    const turn = turns[i++] ?? { text: "(e2e script exhausted)" };
    const text = turn.text ?? "";
    const deltas = Math.max(1, turn.deltas ?? 1);
    const chunk = Math.ceil(text.length / deltas) || text.length;
    for (let p = 0; p < text.length; p += chunk) {
      if (opts.signal.aborted) throw new Error("aborted");
      opts.onDelta({ kind: "text", messageId: opts.messageId, delta: text.slice(p, p + chunk) });
      if (turn.delayMs) await sleepAbortable(turn.delayMs, opts.signal);
    }
    if (opts.signal.aborted) throw new Error("aborted");
    return {
      text,
      toolCalls: (turn.tools ?? []).map((t, idx) => ({
        id: `e2e-${opts.messageId}-${idx}`,
        name: t.name,
        arguments: JSON.stringify(t.args ?? {}),
      })),
    };
  };
}
