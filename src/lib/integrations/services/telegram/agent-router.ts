import "server-only";
import { getAgent } from "@/lib/agent/subagents/store";
import { runSubAgent } from "@/lib/agent/subagents/runner";
import { logger } from "@/lib/logging";
import { readState } from "../../state/store";
import { readBotToken } from "./auth";
import { telegramFetch } from "./client";
import type { TelegramUpdate } from "./adapters/bot";
import { appendMessage, readContext, type ContextMessage } from "./context-cache";

// Auto-reply router for the Telegram bot.
//
// When agent-routing is enabled in state.services.bot.config.agentConfig, every
// incoming text message (from long-poll or webhook — same code path) is:
//   1. Appended to the chat's rolling context (context-cache).
//   2. Handed to the configured sub-agent with the last N turns prepended.
//   3. The agent's textual response is sent back to the chat via sendMessage
//      and also appended to the context (as an `assistant` turn).
//
// Failures never propagate out of routeUpdate — a broken agent must not break
// the poller. If the config declares a `fallbackMessage`, it's sent verbatim
// on any error; otherwise the failure is logged and no reply is sent.

const LOG_COMPONENT = "integrations.telegram.agent-router";

/**
 * Shape stored in state.services.bot.config.agentConfig. All fields are
 * optional to keep the schema forward-compatible; the router treats missing
 * fields as "disabled".
 */
export interface TelegramAgentConfig {
  enabled?: boolean;
  agentId?: string;
  /** "auto_reply" (default) posts a reply automatically. "manual" is a no-op —
   *  reserved for future flows where a human approves the draft in an inbox. */
  mode?: "auto_reply" | "manual";
  /** Turns of prior context injected into the prompt. Defaults to 10. */
  contextDepth?: number;
  /** Sent verbatim on router error when non-empty. */
  fallbackMessage?: string;
}

/** Namespace key for context files — falls back to "default" if the bot isn't
 *  connected. In practice the poller/webhook only run after connect, so the
 *  fallback is defensive. */
function contextNamespace(botInfo: unknown): string {
  const info = botInfo as { id?: number } | undefined;
  return info?.id ? String(info.id) : "default";
}

export interface AgentRouteResult {
  handled: boolean;
  replyText?: string;
  error?: string;
}

/**
 * Route one raw Telegram Update through the configured sub-agent. Safe to
 * fire-and-forget: never throws.
 */
export async function routeUpdate(update: TelegramUpdate): Promise<AgentRouteResult> {
  try {
    const message = update.message ?? update.channel_post;
    const text = message?.text ?? message?.caption;
    if (!message || !text || !text.trim()) return { handled: false };
    // Ignore edits and callback queries — the router only auto-replies to
    // fresh inbound text. Edits are surfaced as separate event types and would
    // otherwise cause double replies.
    if (update.edited_message || update.edited_channel_post || update.callback_query) {
      return { handled: false };
    }

    const state = await readState("telegram");
    const botConfig = state.services["bot"]?.config ?? {};
    const cfg = (botConfig.agentConfig as TelegramAgentConfig | undefined) ?? {};
    if (!cfg.enabled) return { handled: false };
    if ((cfg.mode ?? "auto_reply") !== "auto_reply") return { handled: false };

    const agentId = (cfg.agentId ?? "").trim();
    if (!agentId) return { handled: false };
    const agent = await getAgent(agentId);
    if (!agent) {
      const err = `Configured agent "${agentId}" not found`;
      logger().warn(LOG_COMPONENT, err);
      await sendFallback(message.chat.id, cfg.fallbackMessage);
      return { handled: true, error: err };
    }

    const botId = contextNamespace(botConfig.botInfo);
    const chatId = String(message.chat.id);
    const depth = clampDepth(cfg.contextDepth);
    const history = await readContext(botId, chatId, depth);

    const userTurn: ContextMessage = {
      role: "user",
      content: text,
      timestamp: (message.date ?? Math.floor(Date.now() / 1000)) * 1000,
    };
    await appendMessage(botId, chatId, userTurn);

    const task = buildTask(history, userTurn);
    const run = await runSubAgent(agent, task, { contentOnly: true });
    if (run.error) {
      logger().error(LOG_COMPONENT, "agent run failed", run.error, { agentId, chatId });
      await sendFallback(message.chat.id, cfg.fallbackMessage);
      return { handled: true, error: run.error };
    }
    const replyText = (run.output ?? "").trim();
    if (!replyText) {
      // Agent chose to stay silent — record nothing, send nothing.
      return { handled: true };
    }

    await sendReply(message.chat.id, replyText);
    await appendMessage(botId, chatId, {
      role: "assistant",
      content: replyText,
      timestamp: Date.now(),
    });
    return { handled: true, replyText };
  } catch (err) {
    const message = (err as Error).message ?? "unknown error";
    logger().error(LOG_COMPONENT, "routeUpdate crashed", err);
    return { handled: false, error: message };
  }
}

/**
 * Programmatic entry point used by the `agent_route_message` adapter action —
 * lets a caller (LLM, script, test) drive the router without an actual
 * Telegram Update. `replyChatId` is where the response is sent, and defaults
 * to the same chat that produced the incoming text.
 */
export async function routeManualMessage(input: {
  chatId: string | number;
  text: string;
  agentId?: string;
  contextDepth?: number;
}): Promise<AgentRouteResult> {
  const state = await readState("telegram");
  const botConfig = state.services["bot"]?.config ?? {};
  const cfg = (botConfig.agentConfig as TelegramAgentConfig | undefined) ?? {};
  const agentId = (input.agentId ?? cfg.agentId ?? "").trim();
  if (!agentId) return { handled: false, error: "no agentId configured" };
  const agent = await getAgent(agentId);
  if (!agent) return { handled: false, error: `agent "${agentId}" not found` };

  const botId = contextNamespace(botConfig.botInfo);
  const chatId = String(input.chatId);
  const depth = clampDepth(input.contextDepth ?? cfg.contextDepth);
  const history = await readContext(botId, chatId, depth);
  const userTurn: ContextMessage = {
    role: "user",
    content: input.text,
    timestamp: Date.now(),
  };
  await appendMessage(botId, chatId, userTurn);

  const task = buildTask(history, userTurn);
  const run = await runSubAgent(agent, task, { contentOnly: true });
  if (run.error) return { handled: true, error: run.error };
  const replyText = (run.output ?? "").trim();
  if (!replyText) return { handled: true };
  await sendReply(input.chatId, replyText);
  await appendMessage(botId, chatId, {
    role: "assistant",
    content: replyText,
    timestamp: Date.now(),
  });
  return { handled: true, replyText };
}

function clampDepth(v: number | undefined): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return 10;
  return Math.max(1, Math.min(50, Math.floor(v)));
}

function buildTask(history: ContextMessage[], next: ContextMessage): string {
  // Kept intentionally minimal — the sub-agent's own systemPrompt owns the
  // persona; this prefix only sets the channel + response contract.
  const preamble =
    "You are replying as a Telegram bot in an ongoing chat.\n" +
    "Reply with ONLY the message text (no XML tags, no role labels, no commentary).\n" +
    "Keep replies concise and appropriate for a chat window.";
  const transcript = history
    .map((m) => `<${m.role}>${m.content}</${m.role}>`)
    .join("\n");
  const priorSection = transcript ? `\n\nPrior conversation:\n${transcript}` : "";
  return `${preamble}${priorSection}\n\nNew user message:\n${next.content}\n\nYour reply:`;
}

async function sendReply(chatId: string | number, text: string): Promise<void> {
  const token = await readBotToken();
  if (!token) throw new Error("bot token missing (integration disconnected)");
  // parse_mode omitted deliberately — agent output is free-form text and we
  // don't want stray asterisks to trip MarkdownV2's strict escaping rules.
  await telegramFetch(token, "sendMessage", {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  });
}

async function sendFallback(chatId: string | number, fallback: string | undefined): Promise<void> {
  const text = (fallback ?? "").trim();
  if (!text) return;
  try {
    await sendReply(chatId, text);
  } catch (err) {
    logger().warn(LOG_COMPONENT, "fallback send failed", { chatId, error: (err as Error).message });
  }
}
