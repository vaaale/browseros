import { NextRequest, NextResponse } from "next/server";
import { startAssistantRun } from "@/lib/assistant/start-run";
import { ActiveRunError, runManager, type SurfaceAgentEntry } from "@/lib/assistant/run-manager";
import type { ToolDeclaration } from "@/lib/assistant/tools";
import type { Attachment } from "@/lib/assistant/messages";
import { registerVoiceModeHook } from "@/lib/voice/voice-hook";
import { ensureDefaultPlugins } from "@/lib/plugins/settings";
import { listPlugins, setPluginContext, readPluginsConfig } from "@/lib/plugins/registry";
import { loadAllPlugins } from "@/lib/plugins/loader";
import { dataDir } from "@/os/data-dir";
import { logger } from "@/lib/logging";

export const dynamic = "force-dynamic";

// Register the voice-mode system-prompt hook once at module load time.
registerVoiceModeHook();

// Register default plugins (compaction, memory) at module load time.
// The init modules register themselves with the plugin registry.
import "@/plugins/compaction/init";
import "@/plugins/memory/init";

// Initialize default plugins: ensure they are active in config and call
// initialize() on each with its PluginContext.
const COMPONENT = "plugins.init";
async function initDefaultPlugins(): Promise<void> {
  try {
    // Load marketplace-installed plugins from dataDir()/plugins/ first.
    // This also runs legacy config migration (compaction.json, memoryLoops.json).
    await loadAllPlugins();

    await ensureDefaultPlugins();
    const config = await readPluginsConfig();
    const activeSet = new Set(config.active);
    for (const plugin of listPlugins()) {
      if (!activeSet.has(plugin.manifest.id)) continue;
      if (!plugin.initialize) continue;
      const ctx = {
        dataDir: dataDir(),
        readFile: async (rel: string) => {
          const { promises: fs } = await import("fs");
          const path = await import("path");
          return fs.readFile(path.default.join(dataDir(), "plugins", plugin.manifest.id, rel), "utf8");
        },
        writeFile: async (rel: string, content: string) => {
          const { promises: fs } = await import("fs");
          const path = await import("path");
          const fullPath = path.default.join(dataDir(), "plugins", plugin.manifest.id, rel);
          await fs.mkdir(path.default.dirname(fullPath), { recursive: true });
          await fs.writeFile(fullPath, content, "utf8");
        },
        readTranscript: async (convId: string) => {
          const { loadConversationMessages } = await import("@/lib/assistant/conversation-store");
          return loadConversationMessages(convId);
        },
        log: (level: "debug" | "info" | "warn" | "error", msg: string, data?: Record<string, unknown>) => {
          logger().log({ level, component: `${COMPONENT}.${plugin.manifest.id}`, msg, ...(data ? { data } : {}) });
        },
      };
      setPluginContext(plugin.manifest.id, ctx);
      try {
        await plugin.initialize(ctx);
      } catch (err) {
        logger().error(COMPONENT, `plugin.initialize failed: ${plugin.manifest.id}`, undefined, {
          error: (err as Error).message,
        });
      }
    }
  } catch (err) {
    logger().error(COMPONENT, "default plugin initialization failed", undefined, {
      error: (err as Error).message,
    });
  }
}
void initDefaultPlugins();

// POST — start a run (the loop runs detached from this request).
//   { conversationId, agentId, message, editOfMessageId?, surfaceTools?, surfaceAgents? }
// 409 when the conversation already has an active run (edit-resubmit instead
// auto-cancels it) or when editOfMessageId is not the last user message.
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      conversationId?: string;
      agentId?: string;
      message?: string;
      editOfMessageId?: string;
      surfaceTools?: ToolDeclaration[];
      surfaceAgents?: SurfaceAgentEntry[];
      attachments?: Attachment[];
    };
    const conversationId = body.conversationId?.trim();
    const agentId = body.agentId?.trim();
    const message = typeof body.message === "string" ? body.message : "";
    const attachments = Array.isArray(body.attachments) ? body.attachments : undefined;
    // A message is required UNLESS attachments are present (image-only turns ok).
    if (!conversationId || !agentId || (!message.trim() && !attachments?.length)) {
      return NextResponse.json({ error: "conversationId, agentId and message (or attachments) are required" }, { status: 400 });
    }
    const run = await startAssistantRun({
      conversationId,
      agentId,
      message,
      editOfMessageId: body.editOfMessageId?.trim() || undefined,
      surfaceTools: Array.isArray(body.surfaceTools) ? body.surfaceTools : undefined,
      surfaceAgents: Array.isArray(body.surfaceAgents) ? body.surfaceAgents : undefined,
      attachments,
    });
    return NextResponse.json({ runId: run.id }, { status: 201 });
  } catch (e) {
    if (e instanceof ActiveRunError) {
      return NextResponse.json({ error: e.message, activeRunId: e.activeRunId }, { status: 409 });
    }
    const msg = (e as Error).message;
    const status = /not the last user message/.test(msg) ? 409 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}

// GET ?conversationId= — the conversation's active run, if any (reconnect path).
export async function GET(req: NextRequest) {
  const conversationId = new URL(req.url).searchParams.get("conversationId")?.trim();
  if (!conversationId) {
    return NextResponse.json({ error: "conversationId is required" }, { status: 400 });
  }
  const run = runManager().activeFor(conversationId);
  return NextResponse.json(
    run ? { runId: run.id, agentId: run.agentId, startedAt: run.startedAt, status: run.status } : { runId: null },
  );
}
