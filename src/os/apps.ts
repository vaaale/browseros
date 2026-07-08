import type { AppManifest } from "./types";
import { BUILTIN_APPS as DISCOVERED } from "@/apps/_manifests.generated";

// Built-in apps are self-describing folders under src/apps/<id>/ (manifest.ts +
// index.tsx), discovered at build time by tools/gen-apps.mjs — there is no
// hand-maintained registry to edit, exactly like the GitFS user apps. The
// generated list is id-sorted; we re-sort by each manifest's `order` (then name)
// so the desktop/dock layout is stable and controlled per-app. Runtime-installed
// apps are appended by the SSR seed in src/app/page.tsx.
export const BUILTIN_APPS: AppManifest[] = [...DISCOVERED].sort(
  (a, b) =>
    (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER) ||
    a.name.localeCompare(b.name),
);

export function getApp(id: string, apps: AppManifest[] = BUILTIN_APPS): AppManifest | undefined {
  return apps.find((a) => a.id === id);
}
