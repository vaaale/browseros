import type { AppManifest } from "@/os/types";

const manifest: AppManifest = {
  id: "memory",
  name: "Memory",
  icon: "Brain",
  defaultWidth: 1200,
  defaultHeight: 800,
  order: 40,
  singleton: true,
  builtin: true,
};

export default manifest;
