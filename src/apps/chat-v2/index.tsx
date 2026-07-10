"use client";

import { AssistantChatV2 } from "@/components/agent/v2/AssistantChatV2";

// v2 preview surface (see manifest.ts — temporary, removed in Milestone D).
export default function ChatV2App() {
  return (
    <div className="flex h-full flex-col" data-theme="dark">
      <div className="min-h-0 flex-1">
        <AssistantChatV2 allGroups showConversations />
      </div>
    </div>
  );
}
