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
    "Open an application window. Use bos_app_list to discover available app ids. `params` is passed straight through to the app as its launch parameters, which is how you open a window ALREADY POINTED AT something — e.g. `{appId:\"editor\", params:{file:\"/Documents/report.md\"}}` opens the Editor on that file, `{appId:\"browser\", params:{url:\"https://…\"}}` opens the browser at that URL, `{appId:\"build-studio\", params:{pane:\"self-heal\", caseId:\"0001\"}}` opens Build Studio on one Healing Case. Which keys an app understands is the app's own contract (see its manifest/component); unknown keys are ignored.",
    {
      appId: str("The app id, e.g. files, browser, settings, chat"),
      params: {
        type: "object",
        description:
          "Optional launch parameters handed to the app on open (e.g. {file: \"/Documents/x.md\"} for the Editor, {url: \"https://…\"} for the browser). Omit to open the app on its default view.",
      },
    },
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
  // NOTE: file_list/file_read/file_write/file_mkdir/file_delete/file_rename are
  // NOT here. They are server tools — src/lib/assistant/tools/server/files.ts,
  // alongside file_edit/file_patch/file_search. They lived here until the VFS
  // CRUD tools were moved server-side; the browser handler was only ever a
  // fetch to /api/fs, and being frontend-execution made them uncallable in any
  // headless run. Do not re-add them here: two declarations of one tool is a
  // shadowing bug waiting on registry spread order.
  // See docs/dev/file-tools/file-tools.md.
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
    "Install a multi-facet marketplace ITEM (not just an app) that a Claude developer sub-agent authored into a staging directory — an app (TypeScript/TSX, may import React), a background service, or both together. The staging directory root IS the item root: put an app under dir/app/ (e.g. dir/app/src/main.tsx), a background service under dir/services/ (service.json + entry script — see the service-daemon item model), any default config under dir/config/, and the item's OWN documentation under dir/docs/ — two audience subfolders, 'usage' and 'dev', each holding one folder named after the app (e.g. dir/docs/usage/<Name>/*.md, dir/docs/dev/<Name>/*.md — inside the item, not BOS's source docs), which BOS's Docs app shows once the item is installed. First delegate to the developer (contentOnly) to WRITE that layout into a fresh staging dir; then call app_build with the item name and that directory. A services-only item (no app/ at all) is valid — nothing needs to be 'an app' for this tool to install it. REBUILDING an already-installed item: call app_list first to find its real id (an item's id is fixed at creation and does NOT track renames of its display name), then pass that id here — omitting id when one already exists for this item creates a second, separate, never-the-one-that's-installed item instead of updating it.",
    {
      name: str("Item name"),
      dir: str("Absolute path of the staging directory the developer wrote the item into (top-level layout: app/, services/, config/, docs/ as applicable)"),
      entry: str("App build entry relative to dir/app/; defaults to src/main.tsx or src/main.ts if the item has an app facet"),
      icon: str("Optional lucide icon name; auto-chosen if omitted"),
      id: str("The item's existing id (from app_list) when rebuilding/updating an already-installed item. Omit only when creating a brand-new item — defaults to a slug of `name`, which will NOT match an existing item whose id was set from a different (e.g. earlier or renamed) name."),
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
    "Open (or focus, if already open) the UI Preview window, where you render live UI mockups during a UI design session. Open it at the start of the UI-design phase and keep it open for the rest of the session; then use ui_preview_generate to create a mockup and ui_preview_patch to iterate on it.",
  ),
  decl(
    "dev_branch_request",
    "Set up the active feature branch required to modify BrowserOS itself (its source under src/). Call this BEFORE delegating a source change to the developer when no active feature branch is set; it proposes a name from the task (or from suggestedBranch when provided), lets the user confirm/edit, then creates and activates the bos/<kebab-name> branch on this conversation. Returns a message; only delegate to the developer once a branch is active.\n\nSTATE THE SCOPE. It decides which repositories get the branch, and you already know it — you determined what kind of change this is in order to load the right skills. Getting it wrong creates branches in the user's unrelated projects:\n• `bos-core` — changing BrowserOS itself. Branches BOS's source and user-specs.\n• `marketplace-item` + `scopeId: <item id>` — changing or creating a marketplace app. Branches BOS's source and user-apps.\n• `repository` + `scopeId: <repo id>` — work in one registered repository. Branches that repository ONLY.\nOmitting scope branches BOS's own repositories and never the user's.",
    {
      task: str("The source change you want the developer to make"),
      scope: str(
        "What this change IS: 'bos-core', 'marketplace-item' or 'repository'. Decides which repositories get the branch.",
      ),
      scopeId: str(
        "Required for 'marketplace-item' (the item id, e.g. 'agentic-text-editor') and for 'repository' (the registered repository's id, e.g. 'police-mcp'). Omit for 'bos-core'. For an app that does not exist YET, pass the id it will get — the app's name in lowercase-kebab ('Follow the Money' -> 'follow-the-money') — rather than nothing: until the branch names an item, no row in Build Studio can show that it is the one being worked on.",
      ),
      suggestedBranch: str(
        "Branch slug from the spec's Feature Branch field (without the bos/ prefix, e.g. '001-my-feature'). When provided, pre-fills the branch name input for the user to confirm.",
      ),
    },
    ["task", "scope"],
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
 * `bos_app_list` reads store state and returns it. Every mutating handler —
 * bos_window_close, app_install, the ui_preview family — is deliberately
 * absent: two window mutations in one frame are exactly the race this guards
 * against.
 *
 * The VFS readers (file_read/file_list) used to be listed here too; they are
 * server tools now and carry their own `parallel()` marking in
 * tools/server/files.ts. The rule they encode is unchanged — readers
 * concurrent, writers sequential.
 */
export const PARALLEL_SAFE_FRONTEND_TOOLS = new Set(["bos_app_list"]);
