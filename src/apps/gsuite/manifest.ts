import type { AppManifest } from "@/os/types";

// The concrete migration payoff (design.md §3.8.4, R5): clicking a migrated
// or live GSuite email event opens this thin detail view. Hidden — launched
// only via the Event Viewer's UI-handler resolution, never from the dock.
const manifest: AppManifest = {
  id: "gsuite",
  name: "GSuite",
  icon: "Mail",
  defaultWidth: 640,
  defaultHeight: 520,
  builtin: true,
  hidden: true,
  eventHandlers: [
    {
      id: "gsuite-mail",
      type: "com.bos.gsuite.email.received",
      displayName: "GSuite Mail",
      description: "Open the full email",
      icon: "Mail",
    },
  ],
};

export default manifest;
