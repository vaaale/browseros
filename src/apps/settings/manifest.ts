import type { AppManifest } from "@/os/types";

const manifest: AppManifest = {
  id: "settings",
  name: "Settings",
  icon: "Settings",
  defaultWidth: 860,
  defaultHeight: 620,
  order: 60,
  singleton: true,
  builtin: true,
};

export default manifest;
