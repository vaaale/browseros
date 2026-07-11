import type { AppManifest } from "@/os/types";

const manifest: AppManifest = {
  id: "ui-preview",
  name: "UI Preview",
  icon: "Palette",
  defaultWidth: 980,
  defaultHeight: 700,
  order: 56,
  singleton: true,
  builtin: true,
  // Launched by the Build Studio agent during a bos-app design session, not a
  // primary desktop/dock entry point.
  hidden: true,
};

export default manifest;
