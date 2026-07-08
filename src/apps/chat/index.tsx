"use client";

import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { useOSStore } from "@/store/os-provider";
import { PROVIDERS, type ProviderType } from "@/lib/agent/provider-meta";
import { AssistantChat } from "@/components/agent/AssistantChat";

// The Assistant app is now a consumer of the embeddable <AssistantChat> in
// "all groups" mode: it shows every conversation group nested and switches the
// active agent/conversation as you pick one (012-embeddable-assistant).
export default function ChatApp() {
  const launch = useOSStore((s) => s.launch);
  const [needsKey, setNeedsKey] = useState<{ provider: ProviderType } | null>(null);

  useEffect(() => {
    fetch("/api/agent/provider")
      .then((r) => r.json())
      .then((d) => {
        const cfg = d.config;
        setNeedsKey(cfg && PROVIDERS[cfg.provider as ProviderType]?.keyRequired && !cfg.hasApiKey ? { provider: cfg.provider } : null);
      })
      .catch(() => {});
  }, []);

  return (
    <div className="flex h-full flex-col" data-theme="dark">
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
        <AssistantChat allGroups showConversations showInfo />
      </div>
    </div>
  );
}
