import type { AppManifest } from "@/os/types";

const manifest: AppManifest = {
  id: "docs",
  name: "Docs",
  icon: "BookOpen",
  defaultWidth: 760,
  defaultHeight: 560,
  order: 50,
  singleton: true,
  builtin: true,
};

export default manifest;
