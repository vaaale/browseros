import type { AppManifest } from "@/os/types";

const manifest: AppManifest = {
  id: "docs",
  name: "Docs",
  icon: "BookOpen",
  defaultWidth: 960,
  defaultHeight: 680,
  order: 50,
  singleton: true,
  builtin: true,
};

export default manifest;
