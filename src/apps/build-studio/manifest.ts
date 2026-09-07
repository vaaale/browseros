import type { AppManifest } from "@/os/types";

const manifest: AppManifest = {
  id: "build-studio",
  name: "Build Studio",
  icon: "Hammer",
  defaultWidth: 1320,
  defaultHeight: 720,
  order: 55,
  singleton: true,
  builtin: true,
  // 035-spec-promote-conflict-escalation (FR-007): Build Studio is where a git
  // conflict gets resolved, so it declares the handler for the escalation
  // event. The Event Viewer resolves a clicked event through this; the
  // AUTO-launch (the user takes no action) is the topbar subscriber in
  // src/components/desktop/ConflictLaunch.tsx.
  eventHandlers: [
    {
      id: "conflict-escalated",
      type: "com.bos.gitops.conflict.escalated",
      displayName: "Open conflict resolution",
      description: "Launch the Build Studio conflict-resolution pane for this session",
      icon: "GitMerge",
    },
  ],
  // The event is emitted by the gitops pipeline, not by Build Studio, so it
  // falls outside BS's own `com.bos.build-studio.*` root. Kept as advisory
  // documentation of what BS listens to — since 037 no grant is required.
  eventNamespaces: ["com.bos.gitops.*"],
};

export default manifest;
