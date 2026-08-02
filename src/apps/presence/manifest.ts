import type { AppManifest } from "@/os/types";

// The agent's face (036). Hidden: this is not a place the user goes, it is how
// the assistant appears while it talks. Opened by the video toggle in the
// Assistant — and later by anything else that wants the agent to speak up.
// Singleton because one media session exists at a time.
const manifest: AppManifest = {
  id: "presence",
  // Placeholder: the window is retitled with the engine's own label ("Live
  // Avatar") on mount. Not "Assistant" — the chat app already owns that name, and
  // two windows with one title is a puzzle for the user and for locators.
  name: "Presence",
  icon: "Video",
  // Provisional only: the real geometry comes from the surface's aspect ratio
  // (see PresenceHost), which isn't known until the first video frame.
  defaultWidth: 320,
  defaultHeight: 400,
  singleton: true,
  builtin: true,
  hidden: true,
};

export default manifest;
