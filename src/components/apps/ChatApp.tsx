"use client";

import { useEffect, useState } from "react";
import { CopilotChat } from "@copilotkit/react-ui";
import { useCopilotChat } from "@copilotkit/react-core";
import "@copilotkit/react-ui/styles.css";
import { AlertTriangle, Loader2, CheckCircle2, PanelLeft, PanelRight } from "lucide-react";
import { useOSStore } from "@/store/os-provider";
import { PROVIDERS, type ProviderType } from "@/lib/agent/provider-meta";
import { ChatToolRenderer } from "@/components/agent/ChatToolRenderer";
import { ReasoningAssistantMessage } from "@/components/agent/ReasoningAssistantMessage";
import { markdownRenderers } from "@/components/agent/MarkdownRenderers";
import { ConversationPanel } from "./assistant/ConversationPanel";
import { InfoPanel } from "./assistant/InfoPanel";
import { ProfileSelector } from "./assistant/ProfileSelector";
import { useActiveConversationId } from "@/lib/agent/conversations";
import type { AppProps } from "./types";

const FALLBACK_INSTRUCTIONS =
  "You are the BrowserOS assistant. You can launch apps, manage the virtual file system, open web pages, change the wallpaper, connect MCP servers, delegate to sub-agents, remember things, and build new apps using the provided actions. Prefer doing over describing, and be concise.";

const THEME_OVERRIDES: React.CSSProperties = {
  ["--copilot-kit-primary-color" as string]: "#5b8cff",
  ["--copilot-kit-contrast-color" as string]: "#ffffff",
  ["--copilot-kit-background-color" as string]: "#0f1117",
};

export function ChatApp(_props: AppProps) {
  const launch = useOSStore((s) => s.launch);
  const { isLoading } = useCopilotChat();
  const threadId = useActiveConversationId();
  const [instructions, setInstructions] = useState(FALLBACK_INSTRUCTIONS);
  const [needsKey, setNeedsKey] = useState<{ provider: ProviderType } | null>(null);
  const [showLeft, setShowLeft] = useState(true);
  const [showRight, setShowRight] = useState(true);

  useEffect(() => {
    fetch("/api/assistant/profile")
      .then((r) => r.json())
      .then((d) => d.composed && setInstructions(d.composed))
      .catch(() => {});
    fetch("/api/agent/provider")
      .then((r) => r.json())
      .then((d) => {
        const cfg = d.config;
        setNeedsKey(cfg && PROVIDERS[cfg.provider as ProviderType]?.keyRequired && !cfg.hasApiKey ? { provider: cfg.provider } : null);
      })
      .catch(() => {});
  }, []);

  return (
    <div className="flex h-full" data-theme="dark" style={THEME_OVERRIDES}>
      <ChatToolRenderer />
      {showLeft && <ConversationPanel />}

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-2 border-b border-white/10 bg-white/[0.03] px-2 py-1 text-[11px]">
          <button onClick={() => setShowLeft((v) => !v)} title="Conversations" className="rounded p-1 text-white/50 hover:bg-white/10 hover:text-white">
            <PanelLeft size={14} />
          </button>
          <ProfileSelector />
          <span className="ml-auto flex items-center gap-1.5">
            {isLoading ? (
              <>
                <Loader2 size={12} className="animate-spin text-amber-300" />
                <span className="text-amber-200">Working…</span>
              </>
            ) : (
              <>
                <CheckCircle2 size={12} className="text-emerald-400" />
                <span className="text-white/45">Ready</span>
              </>
            )}
          </span>
          <button onClick={() => setShowRight((v) => !v)} title="Tools / Skills / MCP" className="rounded p-1 text-white/50 hover:bg-white/10 hover:text-white">
            <PanelRight size={14} />
          </button>
        </div>

        {needsKey && (
          <div className="flex shrink-0 items-center gap-2 border-b border-amber-400/20 bg-amber-400/10 px-3 py-2 text-xs text-amber-100">
            <AlertTriangle size={14} className="shrink-0" />
            <span className="flex-1">
              No API key set for <b>{PROVIDERS[needsKey.provider].label}</b>. The assistant can&apos;t respond until you add one.
            </span>
            <button onClick={() => launch("settings")} className="shrink-0 rounded bg-amber-400/20 px-2 py-1 font-medium hover:bg-amber-400/30">
              Open Settings
            </button>
          </div>
        )}

        <div className="min-h-0 flex-1">
          {/* Remount the chat when the conversation changes so it reflects the active thread. */}
          <CopilotChat
            key={threadId}
            className="h-full"
            AssistantMessage={ReasoningAssistantMessage}
            markdownTagRenderers={markdownRenderers}
            instructions={instructions}
            labels={{
              title: "BOS Assistant",
              initial:
                "Hi — I'm your BrowserOS assistant. I can open apps, manage files, browse the web, build apps, and more. What can I do for you?",
            }}
          />
        </div>
      </div>

      {showRight && <InfoPanel />}
    </div>
  );
}
