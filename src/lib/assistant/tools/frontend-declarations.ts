// Declarations of the GLOBAL frontend tools (framework-free — imported by the
// server registry so the model sees them, and by the client binder so handler
// registration can never drift from what the model was offered).
// Handlers live in src/components/agent/v2/FrontendToolsV2.tsx.

import type { ToolDeclaration } from "../tools";

const str = (description: string) => ({ type: "string", description });

function decl(name: string, description: string, properties: Record<string, unknown> = {}, required: string[] = []): ToolDeclaration {
  return { name, description, parameters: { type: "object", properties, required } };
}

export const FRONTEND_TOOL_DECLARATIONS: ToolDeclaration[] = [
  decl(
    "bos_app_launch",
    "Open an application window. Use bos_app_list to discover available app ids.",
    { appId: str("The app id, e.g. files, browser, settings, chat") },
    ["appId"],
  ),
  decl("bos_app_list", "List installed applications and their ids."),
  decl("bos_window_close", "Close an open window by its id.", { windowId: str("The window id") }, ["windowId"]),
  decl(
    "bos_wallpaper_set",
    "Change the desktop wallpaper. Accepts a preset id (aurora, dusk, sunset, ocean, forest, graphite, mono), an image URL, or a VFS image path like /Pictures/bg.png.",
    { wallpaper: str("Preset id, URL, or VFS path") },
    ["wallpaper"],
  ),
  decl("bos_browser_open", "Open a URL in the BrowserOS web browser.", { url: str("The URL or search query") }, ["url"]),
  decl(
    "web_view",
    "Open a sandboxed HTML preview window. Provide `html` (a full HTML document), `filePath` (an absolute VFS path such as /mockups/file.html), or `url` (a same-origin URL or an absolute VFS path — leading-`/` paths that are not `/api/*` are auto-rewritten to `/api/fs/raw?path=...`). The preview runs with `sandbox=allow-scripts` and cannot reach BrowserOS APIs. Set `update=true` to reuse the existing preview window instead of opening a new one — use this for iterative design where you update an HTML file and want to refresh in place.",
    {
      html: str("Full HTML document to render."),
      url: str(
        "URL to load in the preview iframe. Absolute VFS paths (e.g. /mockups/file.html) are auto-rewritten to /api/fs/raw?path=... ; already-qualified URLs like /api/fs/raw?path=... or https://... are used as-is.",
      ),
      filePath: str("Absolute VFS path to an HTML file (e.g. /mockups/file.html). Auto-rewritten to /api/fs/raw?path=..."),
      title: str("Optional window title."),
      update: {
        type: "boolean",
        description:
          "If true, close the existing preview window (if still open) and open a new one in its place instead of spawning an additional window. Use for iterative HTML design.",
      },
    },
  ),
  decl(
    "file_list",
    "List entries in the USER'S virtual file system (their Documents, Pictures, Desktop, etc.). This is sandboxed user data — it does NOT contain BrowserOS's own source code, apps, or Settings pages. To change BrowserOS itself, delegate to the developer sub-agent (see the 'Modify BrowserOS' skill); do not hunt for source here.",
    { path: str('Directory path, defaults to "/"') },
  ),
  decl(
    "file_read",
    "Read a text file from the user's virtual file system (sandboxed user data, NOT BrowserOS source code).",
    { path: str("File path") },
    ["path"],
  ),
  decl(
    "file_write",
    "Create or overwrite a text file in the user's virtual file system (sandboxed user data, NOT BrowserOS source code). To modify BrowserOS itself, delegate to the developer sub-agent instead.",
    { path: str("File path"), content: str("File contents") },
    ["path", "content"],
  ),
  decl("file_mkdir", "Create a directory in the virtual file system.", { path: str("Directory path") }, ["path"]),
  decl("file_delete", "Delete a file or folder from the virtual file system.", { path: str("Path to delete") }, ["path"]),
  decl(
    "agent_request_claude",
    "Ask the user for permission to use a Claude sub-agent for a NON-development task (analysis, research, writing, etc.). Returns 'once', 'session', or 'local'. After receiving permission, immediately call agent_delegate with ephemeralType='claude' (for once/session) or ephemeralType='local' (for local) to actually run the task. Do NOT call this tool for development/coding tasks — use dev_delegate directly instead.",
    { task: str("What you want the Claude agent to do") },
    ["task"],
  ),
  decl(
    "dev_branch_request",
    "Set up the active feature branch required to modify BrowserOS itself (its source under src/). Call this BEFORE delegating a BOS source change to the developer when no active feature branch is set; it proposes a name from the task (or from suggestedBranch when provided), lets the user confirm/edit, then creates and activates the bos/<kebab-name> branch on this conversation. Returns a message; only delegate to the developer once a branch is active.",
    {
      task: str("The BOS source change you want the developer to make"),
      suggestedBranch: str(
        "Branch slug from the spec's Feature Branch field (without the bos/ prefix, e.g. '001-my-feature'). When provided, pre-fills the branch name input for the user to confirm.",
      ),
    },
    ["task"],
  ),
];
