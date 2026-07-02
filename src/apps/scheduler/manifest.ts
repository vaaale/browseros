import type { AppManifest } from "@/os/types";

const manifest: AppManifest = {
  id: "scheduler",
  name: "Scheduler",
  icon: "CalendarClock",
  defaultWidth: 960,
  defaultHeight: 640,
  order: 40,
  singleton: true,
  builtin: true,
};

export default manifest;
