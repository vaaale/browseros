// Run event vocabulary (framework-free). One run = one server-owned agent loop
// for one conversation. Events are appended to the run's log with a monotonic
// `seq`, streamed to attached viewers as NDJSON, and replayable via ?since=.

import type { ChatMessage } from "./messages";

export type RunFinishReason = "completed" | "cancelled" | "error" | "max_steps";

export type RunEventInput =
  | { type: "run_started"; conversationId: string; agentId: string; truncatedFromMessageId?: string }
  | { type: "step_started"; step: number }
  | { type: "text_delta"; messageId: string; delta: string }
  | { type: "reasoning_delta"; messageId: string; delta: string }
  | { type: "tool_call"; callId: string; name: string; args: string; execution: "server" | "frontend" }
  | { type: "tool_progress"; callId: string; event: unknown }
  | { type: "tool_result"; callId: string; result: string }
  | { type: "tool_cancelled"; callId: string }
  | { type: "message"; message: ChatMessage }
  | { type: "state_patch"; patch: Record<string, unknown> }
  | { type: "run_finished"; reason: RunFinishReason; error?: string };

export type RunEvent = RunEventInput & { seq: number; ts: number; runId: string };

export type RunStatus = "running" | RunFinishReason;
