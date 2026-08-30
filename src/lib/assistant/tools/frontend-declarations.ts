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
    "Open a sandboxed preview window for an HTML document, an image, or a video. Provide `html` (a full HTML document), `filePath` (an absolute VFS path such as /mockups/file.html or /Pictures/chart.png), or `url` (a same-origin URL, an external http(s):// URL, a data URI, or an absolute VFS path — leading-`/` paths that are not `/api/*` are auto-rewritten to `/api/fs/raw?path=...`). Images (png, jpg, jpeg, gif, webp, svg, avif) and video (mp4, webm, mov, ogv, m4v, avi) are detected from the target's extension or data-URI MIME type and shown centered and scaled to fit — video with native play/seek/volume/fullscreen controls, tuned by the optional `poster`, `autoplay`, `loop`, and `muted` parameters. Use this to show the user a chart, screenshot, mockup, or clip you produced or found. HTML/URL documents render in an iframe with `sandbox=allow-scripts` and cannot reach BrowserOS APIs. Set `update=true` to reuse the existing preview window instead of opening a new one — use this for iterative design where you update a file and want to refresh in place.",
    {
      html: str("Full HTML document to render."),
      url: str(
        "URL to load in the preview. Absolute VFS paths (e.g. /mockups/file.html) are auto-rewritten to /api/fs/raw?path=... ; already-qualified URLs like /api/fs/raw?path=..., https://..., or data: URIs are used as-is. An image or video URL opens in media mode.",
      ),
      filePath: str(
        "Absolute VFS path to the file to preview — an HTML document (/mockups/file.html), an image (/Pictures/chart.png), or a video (/Videos/clip.mp4). Auto-rewritten to /api/fs/raw?path=...",
      ),
      title: str("Optional window title. Defaults to the file name for image and video targets."),
      update: {
        type: "boolean",
        description:
          "If true, close the existing preview window (if still open) and open a new one in its place instead of spawning an additional window. Use for iterative HTML design.",
      },
      poster: str(
        "Video only: image shown in the player before playback starts. An absolute VFS path (e.g. /Pictures/thumb.jpg) is auto-rewritten to /api/fs/raw?path=... ; a URL or data URI is used as-is. Ignored for images.",
      ),
      autoplay: {
        type: "boolean",
        description:
          "Video only: start playing without user interaction. The browser only permits this when the video is also muted — combine with muted=true, otherwise playback waits for the user to press play.",
      },
      loop: { type: "boolean", description: "Video only: restart playback from the beginning when it reaches the end." },
      muted: { type: "boolean", description: "Video only: start with audio muted. Required for autoplay to be allowed." },
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
    "file_rename",
    "Rename or move a file or folder within the virtual file system.",
    { path: str("Current path"), to: str("New path") },
    ["path", "to"],
  ),
  decl(
    "app_install",
    "Install a BrowserOS app from a single self-contained index.html document, then add it to the dock and open it. Use this AFTER delegating the build to a Claude developer sub-agent (development tasks must not be hand-written). Pass the HTML the sub-agent produced.",
    {
      name: str("App name"),
      html: str("The complete index.html document (all CSS/JS inline, no external dependencies)"),
      icon: str("Optional lucide icon name (e.g. Clock, Calculator, Music, ListTodo); auto-chosen if omitted"),
    },
    ["name", "html"],
  ),
  decl(
    "app_build",
    "Install a multi-facet marketplace ITEM (not just an app) that a Claude developer sub-agent authored into a staging directory — an app (TypeScript/TSX, may import React), a background service, or both together. The staging directory root IS the item root: put an app under dir/app/ (e.g. dir/app/src/main.tsx), a background service under dir/services/ (service.json + entry script — see the service-daemon item model), any default config under dir/config/, and the item's OWN documentation under dir/docs/ — two audience subfolders, 'usage' and 'dev', each holding one folder named after the app (e.g. dir/docs/usage/<Name>/*.md, dir/docs/dev/<Name>/*.md — inside the item, not BOS's source docs), which BOS's Docs app shows once the item is installed. First delegate to the developer (contentOnly) to WRITE that layout into a fresh staging dir; then call app_build with the item name and that directory. A services-only item (no app/ at all) is valid — nothing needs to be 'an app' for this tool to install it.",
    {
      name: str("Item name"),
      dir: str("Absolute path of the staging directory the developer wrote the item into (top-level layout: app/, services/, config/, docs/ as applicable)"),
      entry: str("App build entry relative to dir/app/; defaults to src/main.tsx or src/main.ts if the item has an app facet"),
      icon: str("Optional lucide icon name; auto-chosen if omitted"),
    },
    ["name", "dir"],
  ),
  decl("app_list", "List apps that were installed at runtime (not built-in)."),
  decl(
    "app_uninstall",
    "Uninstall a runtime-installed app by id. This hides it from the desktop but keeps its files, so the user can restore it from Settings → Apps.",
    { id: str("App id") },
    ["id"],
  ),
  decl(
    "agent_request_claude",
    "Ask the user for permission to use a Claude sub-agent for a NON-development task (analysis, research, writing, etc.). Returns 'once', 'session', or 'local'. After receiving permission, call agent_delegate with: ephemeralName (a descriptive name), ephemeralType='claude' (for once/session) or ephemeralType='local' (for local), ephemeralSystemPrompt (required — the agent's instructions), and contentOnly=true (since this is not a BOS source-code task). Do NOT call this tool for development/coding tasks — use dev_delegate directly instead.",
    { task: str("What you want the Claude agent to do") },
    ["task"],
  ),
  decl(
    "ui_preview_open",
    "Open (or focus, if already open) the UI Preview window, where you render live UI mockups during a bos-app design session. Open it at the start of the UI-design phase and keep it open for the rest of the session; then use ui_preview_generate to create a mockup and ui_preview_patch to iterate on it.",
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

/**
 * Frontend tools safe to dispatch concurrently (see `AssistantTool.parallelSafe`
 * and agent-loop.ts's batching). The client path is re-entrant end to end:
 * `dispatchFrontendCall` is per-callId and fire-and-forget, `runToolHandler`
 * (tool-kernel.ts) keeps every controller/timer/abort-registration in a
 * per-call local, `flushSurfaceTools`/`flushSurfaceAgents` already coalesce
 * concurrent callers by design, `postToolResult` is callId-keyed, and the
 * server dedupes with first-result-wins. So the constraint is never the
 * kernel — it is only ever what an individual HANDLER touches.
 *
 * Hence this is an explicit per-tool allowlist rather than a blanket flag:
 * these three read state and return it (a store read, two stateless fetches
 * through `fsClient.scoped()`, which builds a fresh client per call). Every
 * mutating handler — file_write, file_delete, bos_window_close, the ui_preview
 * family — is deliberately absent: two concurrent writes to one path, or two
 * window mutations in one frame, are exactly the races this guards against.
 */
export const PARALLEL_SAFE_FRONTEND_TOOLS = new Set(["file_read", "file_list", "bos_app_list"]);
