import type { AppManifest } from "@/os/types";

const manifest: AppManifest = {
  id: "event-viewer",
  name: "Events",
  icon: "Bell",
  defaultWidth: 780,
  defaultHeight: 560,
  order: 90,
  singleton: true,
  builtin: true,
};

export default manifest;
