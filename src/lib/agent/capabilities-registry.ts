// Single source of truth for agent capabilities (016-unified-agents).
//
// One "agent" has one allowlist (`tools`) that governs it in BOTH contexts:
//  - context "action" → a FRONTEND tool, executed in the browser (id = its name
//    in tools/frontend-declarations.ts, run by components/agent/v2/
//    FrontendToolsV2.tsx); gated server-side in the assistant run's registry.
//  - context "tool"   → a server sub-agent tool (id = the toolsFor() key); gated
//    server-side in runner.ts.
//  - context "both"   → exists in both (e.g. spec ops: a client action + a server tool).
//
// Framework-free (no react, no server-only) so client gating, the server tool
// resolver, the Settings catalog, and InfoPanelV2 all read the same list.

import { actionNameFor } from "@/lib/integrations/actions/dispatcher";
import { GMAIL_METHOD_DESCRIPTORS } from "@/lib/integrations/services/gsuite/adapters/gmail-methods";
import { DRIVE_METHOD_DESCRIPTORS } from "@/lib/integrations/services/gsuite/adapters/drive-methods";
import { CALENDAR_METHOD_DESCRIPTORS } from "@/lib/integrations/services/gsuite/adapters/calendar-methods";
import { CONTACTS_METHOD_DESCRIPTORS } from "@/lib/integrations/services/gsuite/adapters/contacts-methods";
import { TELEGRAM_BOT_METHOD_DESCRIPTORS } from "@/lib/integrations/services/telegram/adapters/bot-methods";

export type CapabilityContext = "action" | "tool" | "both";

export interface Capability {
  id: string;
  /** Group **id** (a slug from `tool-groups.ts`), never a display name — the
   *  stable join key between a capability, its group's description, and any
   *  user override (041 ADR-1). An id that doesn't resolve is a bug to surface,
   *  not something to bucket into a fallback group (041 FR-041). */
  group: string;
  description: string;
  context: CapabilityContext;
  /** Curated extra search vocabulary for find_tools ranking (041 FR-020) —
   *  words a user would plausibly use that the description doesn't contain. */
  aliases?: string[];
}

// Integration capabilities are GENERATED from each service's adapter method
// descriptors (the same descriptors that build the real tool/schema — see
// src/lib/assistant/tools/server/integrations.ts) rather than hand-duplicated
// here. A hand-written copy drifts: Gmail/Drive/Calendar/Contacts used to have
// their own short, independently-written descriptions that no longer matched
// what the tool actually sent to the model, so the description shown/editable
// in Settings → Tools didn't reflect the real tool — and the LONG real
// description was invisible until you'd already saved an override.
function integrationCapabilities(
  integrationId: string,
  serviceId: string,
  /** Group **id** (slug) from `tool-groups.ts`, not a display name. */
  group: string,
  descriptors: readonly { method: string; description: string }[],
): Capability[] {
  return descriptors.map((m) => {
    const id = actionNameFor(integrationId, serviceId, m.method);
    const aliases = INTEGRATION_ALIASES[id];
    return { id, group, context: "action" as const, description: m.description, ...(aliases ? { aliases } : {}) };
  });
}

// Curated search aliases for GENERATED integration capabilities (041 FR-020).
// The generated description comes from the adapter descriptor and is written for
// accuracy, not for retrieval — "messages.send" never says "email". Keyed by the
// same id actionNameFor() produces.
const INTEGRATION_ALIASES: Record<string, string[]> = {
  gmail_messages_send: ["send email", "email someone", "write to", "note to", "compose", "message someone"],
  gmail_messages_list: ["inbox", "unread", "recent mail", "what mail"],
  gmail_messages_search: ["find email", "search inbox"],
  gmail_messages_reply: ["respond to email", "answer mail"],
  gmail_messages_download_attachment: ["attachment", "file from email"],
  calendar_events_create: ["book meeting", "schedule meeting", "set up appointment", "invite", "new event"],
  calendar_events_list: ["my calendar", "agenda", "upcoming", "what is on"],
  calendar_events_delete: ["cancel meeting", "remove event"],
  calendar_freebusy_query: ["free", "availability", "open slot", "busy times"],
  contacts_contacts_search: ["phone number", "find person", "someone details", "look up contact"],
  contacts_contacts_list: ["address book", "all contacts"],
  drive_files_list: ["cloud storage", "my drive", "google doc", "shared file"],
  drive_files_search: ["find in drive"],
  drive_files_export: ["download as", "convert google doc"],
};

const GMAIL_CAPABILITIES = integrationCapabilities("gsuite", "gmail", "gmail", GMAIL_METHOD_DESCRIPTORS);
const DRIVE_CAPABILITIES = integrationCapabilities("gsuite", "drive", "google-drive", DRIVE_METHOD_DESCRIPTORS);
const CALENDAR_CAPABILITIES = integrationCapabilities("gsuite", "calendar", "google-calendar", CALENDAR_METHOD_DESCRIPTORS);
const CONTACTS_CAPABILITIES = integrationCapabilities("gsuite", "contacts", "google-contacts", CONTACTS_METHOD_DESCRIPTORS);
const TELEGRAM_BOT_CAPABILITIES = integrationCapabilities("telegram", "bot", "telegram", TELEGRAM_BOT_METHOD_DESCRIPTORS);

// Tool naming standard: `subsystem_object_verb`, snake_case, one id per logical
// operation. A "both" capability is a single id exposed on BOTH surfaces — the
// main-chat action (client) and the delegated sub-agent tool (server) — sharing
// the operation's implementation.
export const CAPABILITIES: Capability[] = [
  // OS
  { id: "bos_app_launch", group: "os", aliases: ["open app", "start application", "launch window"], context: "action", description: "Open an application window." },
  { id: "bos_window_close", group: "os", context: "action", description: "Close an open window." },
  { id: "bos_app_list", group: "os", context: "action", description: "List installed applications." },
  { id: "bos_wallpaper_set", group: "os", aliases: ["background", "desktop picture", "theme"], context: "action", description: "Change the desktop wallpaper." },
  { id: "bos_browser_open", group: "os", context: "action", description: "Open a URL in the web browser." },

  // Web
  { id: "web_search", group: "web", aliases: ["online", "internet", "look up", "search engine", "current information"], context: "both", description: "Search the web with Anthropic native web search." },
  { id: "web_fetch", group: "web", aliases: ["read article", "open page", "url content", "scrape"], context: "both", description: "Fetch a URL's readable text content." },
  {
    id: "web_view",
    group: "web",
    context: "action",
    description: "Open an HTML document, URL, image, or video in a sandboxed preview window.",
  },

  // Files (VFS) — one id per op, used by the main chat and delegated sub-agents.
  { id: "file_list", group: "files", aliases: ["folder contents", "directory listing", "what files", "pictures", "documents"], context: "both", description: "List a virtual file system directory." },
  { id: "file_read", group: "files", aliases: ["open file", "show file", "contents of"], context: "both", description: "Read a text file." },
  { id: "file_write", group: "files", context: "both", description: "Create or overwrite a text file." },
  { id: "file_mkdir", group: "files", context: "both", description: "Create a directory." },
  { id: "file_delete", group: "files", context: "action", description: "Delete a file or folder." },
  { id: "file_rename", group: "files", context: "action", description: "Rename or move a file or folder." },
  { id: "file_edit", group: "files", context: "both", description: "Find and replace a unique string in a VFS file." },
  { id: "file_patch", group: "files", context: "both", description: "Apply multiple find/replace hunks atomically to a VFS file." },
  { id: "file_search", group: "files", aliases: ["grep", "find text", "mention", "occurrence", "where is"], context: "both", description: "Search file content across a VFS subtree." },
  { id: "file_glob", group: "files", aliases: ["find files", "by pattern", "wildcard"], context: "both", description: "Find files matching a glob pattern in a VFS subtree." },
  { id: "file_to_markdown", group: "files", aliases: ["pdf", "word document", "powerpoint", "excel", "spreadsheet", "extract text", "convert document"], context: "both", description: "Convert a PDF/DOCX/PPTX/XLSX file under /workspace to markdown (via the sandbox's markitdown)." },
  { id: "view_image", group: "files", aliases: ["screenshot", "photo", "picture", "look at image"], context: "both", description: "View an image at a VFS path as a real vision content block (not OCR)." },
  { id: "video_keyframes", group: "files", aliases: ["video frames", "clip", "thumbnail", "scrub"], context: "both", description: "Sample keyframes from a video under /workspace (via ffmpeg) and view them as images." },

  // Config
  { id: "config_list", group: "config", aliases: ["settings", "configurable"], context: "action", description: "List configurable settings." },
  { id: "config_set", group: "config", aliases: ["change setting", "turn on", "turn off", "preference", "enable", "disable"], context: "action", description: "Update a configuration value." },

  // Agents (delegation + self)
  { id: "agent_list", group: "agents", context: "action", description: "List available agents." },
  { id: "agent_create", group: "agents", context: "action", description: "Create a reusable agent." },
  { id: "agent_delegate", group: "agents", context: "action", description: "Delegate a task to an agent." },
  { id: "Agent", group: "agents", context: "action", description: "Claude Code-compatible agent launcher (maps to agent_delegate / dev_delegate)." },
  { id: "agent_request_claude", group: "agents", context: "action", description: "Ask to use a Claude agent for a non-dev task." },
  { id: "agent_prompt_get", group: "agents", context: "action", description: "Read the active agent's editable personality." },
  { id: "agent_prompt_set", group: "agents", context: "action", description: "Rewrite the active agent's personality." },
  { id: "agent_definition_get", group: "agents", context: "action", description: "Read ANY named agent's current live definition (id, tools, skills, systemPrompt) — read-only, for auditing a different agent than the caller's own." },

  // Conversation review (auditing a past conversation's behavior — see the
  // conversation-reviewer agent)
  { id: "conversation_overview", group: "conversation-review", context: "action", description: "Get a past conversation's shape (title, agents involved, total pages) before reviewing it." },
  { id: "conversation_page", group: "conversation-review", context: "action", description: "Fetch one page of a past conversation's transcript, condensed for review." },
  { id: "submit_review_report", group: "conversation-review", context: "action", description: "Save a conversation-behavior review report — refuses unless every page was actually reviewed." },

  // Memory
  { id: "memory_save", group: "memory", aliases: ["remember", "store fact", "keep in mind", "note about me"], context: "action", description: "Save to persistent memory." },
  { id: "memory_recall", group: "memory", aliases: ["what do you know", "stored facts", "preferences", "remembered"], context: "action", description: "Read live persistent memory entries or a topic shard." },
  { id: "memory_replace", group: "memory", context: "action", description: "Update an existing memory entry's text in place." },
  { id: "memory_remove", group: "memory", context: "action", description: "Delete a memory entry from a topic." },
  { id: "memory_search", group: "memory", aliases: ["find memory", "past context"], context: "action", description: "Search topic shards + recent episodes for matching entries." },

  // Skills
  { id: "skill_list", group: "skills", aliases: ["playbook", "available procedures", "how do I"], context: "both", description: "List available skills." },
  { id: "skill_load", group: "skills", context: "both", description: "Load a skill's full instructions." },
  { id: "skill_read_file", group: "skills", context: "both", description: "Read a bundled reference/script file from a skill." },
  { id: "skill_save", group: "skills", context: "action", description: "Save a reusable skill." },
  { id: "self_improve", group: "skills", context: "action", description: "Background self-improvement from an honest reflection on approach criticism." },
  { id: "skill_improve", group: "skills", context: "action", description: "Improve a skill from feedback (GEPA)." },
  { id: "skill_curate", group: "skills", context: "action", description: "Archive stale agent-created skills (recoverable)." },

  // Scratchpad (conversation-scoped notes; state derived from tool-call history)
  { id: "scratchpad_write", group: "scratchpad", aliases: ["jot", "note down", "temporary note"], context: "action", description: "Create a note in the conversation-scoped scratchpad." },
  { id: "scratchpad_read", group: "scratchpad", context: "action", description: "Read scratchpad notes (list metadata or fetch one by title)." },
  { id: "scratchpad_edit", group: "scratchpad", context: "action", description: "Replace the content of an existing scratchpad note." },
  { id: "scratchpad_delete", group: "scratchpad", context: "action", description: "Delete a scratchpad note by title." },

  // MCP
  { id: "mcp_server_list", group: "mcp", context: "action", description: "List connected MCP servers (with descriptions)." },
  { id: "mcp_tool_search", group: "mcp", context: "action", description: "Search MCP tools across all servers or on a specific server." },
  { id: "mcp_server_tools", group: "mcp", context: "action", description: "List a server's tools with their input schemas." },
  { id: "mcp_tool_schema", group: "mcp", context: "action", description: "Get the input JSON schema for a single MCP tool." },
  { id: "mcp_tool_call", group: "mcp", context: "action", description: "Call a tool on an MCP server with schema-validated arguments." },
  { id: "mcp_server_add", group: "mcp", context: "action", description: "Connect an MCP server." },
  { id: "mcp_server_remove", group: "mcp", context: "action", description: "Disconnect an MCP server." },

  // Apps (runtime-installed apps)
  { id: "app_install", group: "apps", aliases: ["add app"], context: "action", description: "Install an app from generated HTML." },
  { id: "app_build", group: "apps", context: "action", description: "Build & install a multi-file TS/TSX app project." },
  { id: "app_list", group: "apps", context: "action", description: "List runtime-installed apps." },
  { id: "app_uninstall", group: "apps", aliases: ["remove app", "get rid of application", "delete app"], context: "action", description: "Uninstall an app." },

  // Specs (marketplace-item specs only — BOS-core/user specs use file_* on /Specs/)
  { id: "app_spec_create", group: "specs", context: "both", description: "Create a marketplace item's spec, bringing the item into existence even before any code does." },
  { id: "app_spec_list", group: "specs", context: "both", description: "List a marketplace item's spec artifacts." },
  { id: "app_spec_read", group: "specs", context: "both", description: "Read a marketplace item's spec artifact." },
  { id: "app_spec_write", group: "specs", context: "both", description: "Replace a marketplace item's spec artifact's entire content." },
  { id: "app_spec_edit", group: "specs", context: "both", description: "Find-and-replace a unique snippet in a marketplace item's spec artifact." },
  { id: "app_spec_patch", group: "specs", context: "both", description: "Apply several find/replace edits to a marketplace item's spec artifact atomically." },

  // Dev (repo + harness)
  { id: "dev_git_status", group: "dev", aliases: ["what changed", "uncommitted", "working tree", "branch status", "diff"], context: "both", description: "Show git branch and changes (read-only)." },
  { id: "dev_branch_request", group: "dev", context: "action", description: "Set up the active feature branch needed to modify BOS source." },
  { id: "dev_delegate", group: "dev", context: "tool", description: "Delegate implementation to the Developer (from a delegated agent)." },
  { id: "bos_source_list", group: "dev", context: "both", description: "List BOS source (read-only, sub-agent)." },
  { id: "bos_source_read", group: "dev", context: "both", description: "Read a BOS source file (read-only, sub-agent)." },
  { id: "bos_source_search", group: "dev", context: "both", description: "Search BOS source (read-only, sub-agent)." },
  { id: "run_command", group: "dev", aliases: ["shell", "bash", "terminal", "execute", "script"], context: "both", description: "Run a shell command in a sandboxed environment (python3, node, pip3, etc.)." },

  // Git conflict resolution (035-spec-promote-conflict-escalation). The whole
  // access mechanism the conflict-resolution agent gets: repo-scoped, gated to
  // the session's own working context, identical for every managed repo. An
  // agent selected as the conflict agent (Settings -> Build Studio) MUST list
  // these, or its escalation fails loudly at the first tool call.
  { id: "conflict_read", group: "conflict-resolution", aliases: ["merge conflict", "conflicting file", "ours theirs", "sort out merge"], context: "tool", description: "Read the ours/base/theirs content and marker hunks of a conflicting file in the active conflict-resolution session." },
  { id: "conflict_write", group: "conflict-resolution", aliases: ["resolve conflict", "fix merge"], context: "tool", description: "Write the resolved (markers-removed) content of a conflicting file back into the session's repo." },
  { id: "conflict_decision", group: "conflict-resolution", context: "tool", description: "Ask the user to decide a genuinely ambiguous conflict; parks the session until they answer." },
  { id: "conflict_status", group: "conflict-resolution", context: "tool", description: "Report the conflict session's status, per-file progress, and decision timeline." },
  { id: "conflict_complete", group: "conflict-resolution", context: "tool", description: "Declare the conflict resolved and complete the underlying git operation." },
  { id: "conflict_abandon", group: "conflict-resolution", context: "tool", description: "Abandon the resolution and roll the repo back to its pre-reconciliation state." },

  // Scheduler (025-agent-delegation-v2, Phase 4 — ported natively into v2's
  // registry; these existed only in the legacy engine before, so no agent's
  // allowlist could reference them from the main/primary personality).
  { id: "list_scheduled_tasks", group: "scheduler", aliases: ["automations", "what is scheduled", "recurring jobs"], context: "tool", description: "List scheduled jobs." },
  { id: "get_scheduled_task", group: "scheduler", context: "tool", description: "Get a scheduled job by id, including its recent execution history." },
  { id: "create_scheduled_task", group: "scheduler", aliases: ["every morning", "recurring", "cron", "schedule it", "repeat", "daily", "nightly"], context: "tool", description: "Create a new scheduled job." },
  { id: "update_scheduled_task", group: "scheduler", context: "tool", description: "Update a scheduled job's fields." },
  { id: "update_task_schedule", group: "scheduler", context: "tool", description: "Update just the schedule of a job, leaving other fields unchanged." },
  { id: "pause_scheduled_task", group: "scheduler", aliases: ["stop recurring", "suspend job", "disable schedule"], context: "tool", description: "Pause a scheduled job. Its nextRunAt is cleared until resumed." },
  { id: "resume_scheduled_task", group: "scheduler", aliases: ["restart job", "re-enable schedule"], context: "tool", description: "Resume a paused job and recalculate its next run time." },
  { id: "delete_scheduled_task", group: "scheduler", aliases: ["remove schedule", "cancel job"], context: "tool", description: "Delete a scheduled job." },
  { id: "run_task_now", group: "scheduler", aliases: ["trigger now", "run immediately"], context: "tool", description: "Run a scheduled job immediately, regardless of its schedule." },

  // Build Studio app control (registered in the BS app's embedded chat).
  { id: "buildstudio_artifact_open", group: "build-studio", context: "action", description: "Open a spec artifact in the Build Studio viewer." },
  { id: "buildstudio_artifact_highlight", group: "build-studio", context: "action", description: "Scroll (centered) to a heading/section anchor in the open Build Studio artifact and highlight the whole section until the user clicks it." },
  { id: "buildstudio_tree_refresh", group: "build-studio", context: "action", description: "Reload the Build Studio spec tree." },
  { id: "buildstudio_run_tests", group: "build-studio", context: "action", description: "Run the Playwright e2e tests for a feature and write test-results.md to its spec folder." },

  // UI Preview (013-build-studio-agentic V2). Tier 1 (ui_preview_open) is a
  // global frontend tool declared in frontend-declarations.ts; Tier 2 tools
  // are registered by the UI Preview window itself while it is open.
  { id: "ui_preview_open", group: "ui-preview", context: "action", description: "Open or focus the UI Preview window." },
  { id: "ui_preview_generate", group: "ui-preview", context: "action", description: "Generate a UI mockup from a natural-language description and render it in the open UI Preview window (one step)." },
  { id: "ui_preview_patch", group: "ui-preview", context: "action", description: "Incrementally change the mockup showing in the UI Preview window (add/replace/remove an element) from a natural-language instruction." },
  { id: "ui_preview_show_requirement", group: "ui-preview", context: "action", description: "Scroll the paired spec viewer to a requirement from the UI Preview." },

  // Integrations — one capability id per adapter method, following the pattern
  // `<serviceId>_<object>_<verb>` in snake_case (see actions/dispatcher.ts).
  // Example: `gmail_messages_list`, `drive_files_list`. GENERATED from each
  // service's adapter method descriptors (see `integrationCapabilities` above)
  // so the description shown/editable in Settings → Tools always matches the
  // real tool description sent to the model — no hand-duplicated copy to drift.
  //
  // GROUPING: integration capabilities are grouped per external service (not
  // under a single "Integrations" bucket) so the Settings capability picker
  // stays scannable as more providers are added. Non-Google providers should
  // use their own service-name group.
  ...GMAIL_CAPABILITIES,
  ...DRIVE_CAPABILITIES,
  ...CALENDAR_CAPABILITIES,
  ...CONTACTS_CAPABILITIES,
  ...TELEGRAM_BOT_CAPABILITIES,
];

// Tools/actions the UI marks with a warning affordance in the Agent Settings
// capability picker. Kept as a UI-layer hardcoded list rather than a field on
// Capability so the registry stays a pure inventory (the "danger" judgement is
// presentational, not a property of the tool). Add ids here to opt into the
// warning styling — matching happens by exact id against the capability id.
const DANGEROUS_TOOL_NAMES: readonly string[] = [
  "file_delete", // destructive VFS delete
  "run_command", // arbitrary command execution (sandboxed, but still powerful)
  "bot_messages_delete", // destructive Telegram message delete
];

/** Ids the UI should annotate as dangerous (warning icon + red description). */
export function getDangerousToolNames(): readonly string[] {
  return DANGEROUS_TOOL_NAMES;
}

// Dynamic extension point — plugins call registerAdditionalCapabilities() from
// their activate() hook. Backed by globalThis so it survives HMR re-evaluations.
const DYNAMIC_CAPS_KEY = "__bos_dynamic_capabilities__" as const;

function getDynamicCapabilities(): Capability[] {
  const g = globalThis as Record<string, unknown>;
  if (!Array.isArray(g[DYNAMIC_CAPS_KEY])) g[DYNAMIC_CAPS_KEY] = [];
  return g[DYNAMIC_CAPS_KEY] as Capability[];
}

export function registerAdditionalCapabilities(caps: Capability[]): void {
  const dynamic = getDynamicCapabilities();
  for (const cap of caps) {
    const idx = dynamic.findIndex((c) => c.id === cap.id);
    if (idx !== -1) dynamic[idx] = cap;
    else dynamic.push(cap);
  }
}

export function unregisterCapabilities(ids: string[]): void {
  const dynamic = getDynamicCapabilities();
  const toRemove = new Set(ids);
  const keep = dynamic.filter((c) => !toRemove.has(c.id));
  dynamic.length = 0;
  dynamic.push(...keep);
}

/** Full capability list: static built-ins + dynamically registered plugin caps. */
export function listCapabilities(): Capability[] {
  return [...CAPABILITIES, ...getDynamicCapabilities()];
}

/** Is this id a main-chat action (static or dynamically registered)? */
export function isActionId(id: string): boolean {
  return listCapabilities().some((c) => c.context !== "tool" && c.id === id);
}

// The per-agent action gate (016 + Phase B strict allowlist). Contract:
//   - allow == null/undefined → LOADING; temporarily allow everything so the
//     first render doesn't flicker actions to disabled before the fetch resolves.
//   - Array.isArray(allow) && allow.length === 0 → EXPLICIT ZERO; disallow every
//     action id. An agent configured with no tools has no tools.
//   - Array.isArray(allow) && allow.length > 0 → STRICT allowlist; only ids that
//     appear in the list are allowed.
//
// The on-disk migration in subagents/store.ts backfills legacy agents with the
// full capability set, so this strict rule cannot silently strip actions from
// an existing user's agents on upgrade. Framework-free so the client provider
// and tests share one source of truth.
export function resolveActionGate(allow: string[] | null | undefined): (id: string) => boolean {
  if (allow == null) return () => true;
  if (allow.length === 0) return () => false;
  const set = new Set(allow);
  return (id) => set.has(id);
}

/** All capabilities that surface as main-chat actions. */
export function actionCapabilities(): Capability[] {
  return CAPABILITIES.filter((c) => c.context !== "tool");
}

/** Capability ids deferred BY REGISTRY DEFAULT (hidden from initial context,
 *  discovered via find_tools). Since the Claude-compatibility refactor the
 *  registry no longer marks any capability deferred by default — deferral is
 *  now entirely per-agent (`agent.deferredTools`), which runners union with
 *  this set. Kept as the (empty) default layer so that union stays a single
 *  code path. */
export function deferredCapabilityIds(): Set<string> {
  return new Set<string>();
}
