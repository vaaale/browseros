import "server-only";
import * as vfs from "@/os/vfs";
import { enqueuePerKey } from "@/lib/agent/write-queue";
import { generateTitle } from "@/lib/agent/title";
import { loadConversationMessages } from "./conversation-store";
import type { RunHooks } from "./hooks";
import { logger } from "@/lib/logging";

// Server-side auto-titling: after a run completes, if the conversation still has
// the default title, generate one from its first user→assistant exchange. This
// is the v2 replacement for the client's post-exchange title fetch — it rides on
// the RunHooks seam and runs in the background (fire-and-forget within the hook).

const DEFAULT_TITLE = "New conversation";
const CHATS_DIR = "/Documents/Chats";

function firstText(messages: { role: string; content?: string }[], role: string): string {
  for (const m of messages) {
    if (m.role === role && typeof m.content === "string" && m.content.trim()) return m.content;
  }
  return "";
}

export const titleHook: RunHooks = {
  onRunFinished: async (summary, ctx) => {
    if (summary.reason !== "completed") return;
    const path = `${CHATS_DIR}/${ctx.conversationId}.json`;
    let file: { title?: string } | undefined;
    try {
      file = JSON.parse(await vfs.readText(path)) as { title?: string };
    } catch {
      return;
    }
    if (!file || (file.title && file.title !== DEFAULT_TITLE)) return;

    const messages = await loadConversationMessages(ctx.conversationId);
    const userText = firstText(messages, "user");
    const assistantText = firstText(messages, "assistant");
    if (!userText || !assistantText) return;

    let title = "";
    try {
      title = await generateTitle(userText, assistantText);
    } catch (err) {
      logger().error("assistant.title", "title generation failed", err);
      return;
    }
    if (!title) return;

    // Re-read under the write queue so we never clobber a concurrent rename.
    await enqueuePerKey(ctx.conversationId, async () => {
      try {
        const current = JSON.parse(await vfs.readText(path)) as Record<string, unknown>;
        if (current.title && current.title !== DEFAULT_TITLE) return;
        current.title = title;
        await vfs.writeText(path, JSON.stringify(current, null, 2));
        logger().info("assistant.title", "titled conversation", { conversation: ctx.conversationId, title });
      } catch {
        /* best-effort */
      }
    });
  },
};
