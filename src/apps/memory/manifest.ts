import type { AppManifest } from "@/os/types";

const manifest: AppManifest = {
  id: "memory",
  name: "Memory",
  icon: "Brain",
  defaultWidth: 640,
  defaultHeight: 520,
  order: 40,
  singleton: true,
  builtin: true,
};

export default manifest;
