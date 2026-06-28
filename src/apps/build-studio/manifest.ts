import type { AppManifest } from "@/os/types";

const manifest: AppManifest = {
  id: "build-studio",
  name: "Build Studio",
  icon: "Hammer",
  defaultWidth: 920,
  defaultHeight: 640,
  order: 55,
  singleton: true,
  builtin: true,
};

export default manifest;
