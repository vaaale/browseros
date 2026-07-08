import type { AppManifest } from "@/os/types";

const manifest: AppManifest = {
  id: "chat",
  name: "Assistant",
  icon: "Bot",
  defaultWidth: 1000,
  defaultHeight: 720,
  order: 30,
  singleton: true,
  builtin: true,
};

export default manifest;
