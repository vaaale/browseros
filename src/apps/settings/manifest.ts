import type { AppManifest } from "@/os/types";

const manifest: AppManifest = {
  id: "settings",
  name: "Settings",
  icon: "Settings",
  defaultWidth: 680,
  defaultHeight: 500,
  order: 60,
  singleton: true,
  builtin: true,
};

export default manifest;
