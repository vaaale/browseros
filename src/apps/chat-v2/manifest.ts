import type { AppManifest } from "@/os/types";

// TEMPORARY preview app for the v2 (server-owned runs) Assistant. Lets v2 be
// tested side-by-side with the CopilotKit chat; removed in Milestone D when
// the Assistant app itself switches to AssistantChatV2.
const manifest: AppManifest = {
  id: "chat-v2",
  name: "Assistant v2 (preview)",
  icon: "Bot",
  defaultWidth: 1000,
  defaultHeight: 720,
  order: 31,
  singleton: true,
  builtin: true,
};

export default manifest;
