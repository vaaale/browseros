// Single source of truth for agent capabilities (016-unified-agents).
//
// One "agent" has one allowlist (`tools`) that governs it in BOTH contexts:
//  - context "action" → a main-chat CopilotKit action (id = the useCopilotAction
//    name); gated server-side in the CopilotKit route's language-model wrapper.
//  - context "tool"   → a server sub-agent tool (id = the toolsFor() key); gated
//    server-side in runner.ts.
//  - context "both"   → exists in both (e.g. spec ops: a client action + a server tool).
//
// Framework-free (no react, no server-only) so client gating, the server tool
// resolver, the Settings catalog, and the InfoPanel all read the same list.

import { actionNameFor } from "@/lib/integrations/actions/dispatcher";
import { TELEGRAM_BOT_METHOD_DESCRIPTORS } from "@/lib/integrations/services/telegram/adapters/bot-methods";

export type CapabilityContext = "action" | "tool" | "both";

export interface Capability {
  id: string;
  group: string;
  description: string;
  context: CapabilityContext;
  /**
   * Deferred tools are excluded from an agent's initial tool schema (025-deferred-
   * tool-discovery). Agents discover them at runtime via `find_tools(query)` and
   * they become callable in subsequent steps of the same tool loop. Default false.
   */
  deferred?: boolean;
}

const TELEGRAM_BOT_CAPABILITIES: Capability[] = TELEGRAM_BOT_METHOD_DESCRIPTORS.map((m) => ({
  id: actionNameFor("telegram", "bot", m.method),
  group: "Telegram",
  context: "action",
  description: m.description,
  deferred: true,
}));

// Tool naming standard: `subsystem_object_verb`, snake_case, one id per logical
// operation. A "both" capability is a single id exposed on BOTH surfaces — the
// main-chat action (client) and the delegated sub-agent tool (server) — sharing
// the operation's implementation.
export const CAPABILITIES: Capability[] = [
  // OS
  { id: "bos_app_launch", group: "OS", context: "action", description: "Open an application window." },
  { id: "bos_window_close", group: "OS", context: "action", description: "Close an open window." },
  { id: "bos_app_list", group: "OS", context: "action", description: "List installed applications." },
  { id: "bos_wallpaper_set", group: "OS", context: "action", description: "Change the desktop wallpaper." },
  { id: "bos_browser_open", group: "OS", context: "action", description: "Open a URL in the web browser." },

  // Web
  { id: "web_search", group: "Web", context: "both", description: "Search the web with Anthropic native web search." },
  { id: "web_fetch", group: "Web", context: "both", description: "Fetch a URL's readable text content.", deferred: true },
  { id: "web_view", group: "Web", context: "action", description: "Open an HTML document or URL in a sandboxed preview window." },

  // Files (VFS) — one id per op, used by the main chat and delegated sub-agents.
  { id: "file_list", group: "Files", context: "both", description: "List a virtual file system directory." },
  { id: "file_read", group: "Files", context: "both", description: "Read a text file." },
  { id: "file_write", group: "Files", context: "both", description: "Create or overwrite a text file." },
  { id: "file_mkdir", group: "Files", context: "both", description: "Create a directory.", deferred: true },
  { id: "file_delete", group: "Files", context: "action", description: "Delete a file or folder.", deferred: true },

  // Config
  { id: "config_list", group: "Config", context: "action", description: "List configurable settings." },
  { id: "config_set", group: "Config", context: "action", description: "Update a configuration value." },

  // Agents (delegation + self)
  { id: "agent_list", group: "Agents", context: "action", description: "List available agents." },
  { id: "agent_create", group: "Agents", context: "action", description: "Create a reusable agent." },
  { id: "agent_delegate", group: "Agents", context: "action", description: "Delegate a task to an agent." },
  { id: "agent_request_claude", group: "Agents", context: "action", description: "Ask to use a Claude agent for a non-dev task." },
  { id: "agent_prompt_get", group: "Agents", context: "action", description: "Read the active agent's editable personality." },
  { id: "agent_prompt_set", group: "Agents", context: "action", description: "Rewrite the active agent's personality." },

  // Memory
  { id: "memory_save", group: "Memory", context: "action", description: "Save to persistent memory.", deferred: true },
  { id: "memory_recall", group: "Memory", context: "action", description: "Read live persistent memory entries or a topic shard." },
  { id: "memory_search", group: "Memory", context: "action", description: "Search topic shards + recent episodes for matching entries.", deferred: true },

  // Skills
  { id: "skill_list", group: "Skills", context: "both", description: "List available skills." },
  { id: "skill_load", group: "Skills", context: "both", description: "Load a skill's full instructions." },
  { id: "skill_read_file", group: "Skills", context: "both", description: "Read a bundled reference/script file from a skill." },
  { id: "skill_save", group: "Skills", context: "action", description: "Save a reusable skill." },
  { id: "skill_reflect", group: "Skills", context: "action", description: "Run the self-improvement review after a task." },
  { id: "skill_improve", group: "Skills", context: "action", description: "Improve a skill from feedback (GEPA)." },
  { id: "skill_curate", group: "Skills", context: "action", description: "Archive stale agent-created skills (recoverable)." },

  // Scratchpad (conversation-scoped notes; state derived from tool-call history)
  { id: "scratchpad_write", group: "Scratchpad", context: "action", description: "Create a note in the conversation-scoped scratchpad.", deferred: true },
  { id: "scratchpad_read", group: "Scratchpad", context: "action", description: "Read scratchpad notes (list metadata or fetch one by title).", deferred: true },
  { id: "scratchpad_edit", group: "Scratchpad", context: "action", description: "Replace the content of an existing scratchpad note.", deferred: true },
  { id: "scratchpad_delete", group: "Scratchpad", context: "action", description: "Delete a scratchpad note by title.", deferred: true },

  // MCP
  { id: "mcp_server_list", group: "MCP", context: "action", description: "List connected MCP servers (with descriptions).", deferred: true },
  { id: "mcp_tool_search", group: "MCP", context: "action", description: "Search MCP tools across all servers or on a specific server.", deferred: true },
  { id: "mcp_server_tools", group: "MCP", context: "action", description: "List a server's tools with their input schemas.", deferred: true },
  { id: "mcp_tool_schema", group: "MCP", context: "action", description: "Get the input JSON schema for a single MCP tool.", deferred: true },
  { id: "mcp_tool_call", group: "MCP", context: "action", description: "Call a tool on an MCP server with schema-validated arguments.", deferred: true },
  { id: "mcp_server_add", group: "MCP", context: "action", description: "Connect an MCP server.", deferred: true },
  { id: "mcp_server_remove", group: "MCP", context: "action", description: "Disconnect an MCP server.", deferred: true },

  // Apps (runtime-installed apps)
  { id: "app_install", group: "Apps", context: "action", description: "Install an app from generated HTML." },
  { id: "app_build", group: "Apps", context: "action", description: "Build & install a multi-file TS/TSX app project." },
  { id: "app_list", group: "Apps", context: "action", description: "List runtime-installed apps." },
  { id: "app_uninstall", group: "Apps", context: "action", description: "Uninstall an app." },

  // Dev (repo + harness)
  { id: "dev_git_status", group: "Dev", context: "both", description: "Show git branch and changes (read-only).", deferred: true },
  { id: "dev_branch_request", group: "Dev", context: "action", description: "Set up the active feature branch needed to modify BOS source.", deferred: true },
  { id: "dev_delegate", group: "Dev", context: "tool", description: "Delegate implementation to the Developer (from a delegated agent).", deferred: true },
  { id: "bos_source_list", group: "Dev", context: "both", description: "List BOS source (read-only, sub-agent).", deferred: true },
  { id: "bos_source_read", group: "Dev", context: "both", description: "Read a BOS source file (read-only, sub-agent).", deferred: true },
  { id: "bos_source_search", group: "Dev", context: "both", description: "Search BOS source (read-only, sub-agent).", deferred: true },
  { id: "run_command", group: "Dev", context: "both", description: "Run a command in a sandboxed environment (bash/python/node).", deferred: true },

  // Docs
  { id: "docs_list", group: "Docs", context: "action", description: "List documentation pages." },
  { id: "docs_read", group: "Docs", context: "action", description: "Read a documentation page by ref." },

  // Workflows
  { id: "workflow_create", group: "Workflows", context: "action", description: "Generate a workflow from a description.", deferred: true },
  { id: "workflow_modify", group: "Workflows", context: "action", description: "Apply a JSON-merge patch to a workflow.", deferred: true },
  { id: "workflow_run", group: "Workflows", context: "action", description: "Execute a workflow and stream step events.", deferred: true },
  { id: "workflow_status", group: "Workflows", context: "action", description: "Read a workflow's execution state.", deferred: true },
  { id: "workflow_cancel", group: "Workflows", context: "action", description: "Cancel a running workflow.", deferred: true },
  { id: "workflow_export", group: "Workflows", context: "action", description: "Return a workflow's full JSON.", deferred: true },
  { id: "workflow_validate", group: "Workflows", context: "action", description: "Validate a workflow's DAG.", deferred: true },

  // Specs (one id per op, used by the main chat and delegated sub-agents).
  { id: "spec_list", group: "Specs", context: "both", description: "List spec artifacts under a store.", deferred: true },
  { id: "spec_read", group: "Specs", context: "both", description: "Read a spec artifact.", deferred: true },
  { id: "spec_write", group: "Specs", context: "both", description: "Create/overwrite a spec artifact.", deferred: true },
  { id: "spec_edit", group: "Specs", context: "both", description: "Find/replace within a spec artifact.", deferred: true },
  { id: "spec_search", group: "Specs", context: "both", description: "Search spec artifacts.", deferred: true },
  { id: "spec_template_read", group: "Specs", context: "both", description: "Read a spec-kit template/command prompt.", deferred: true },
  { id: "spec_template_list", group: "Specs", context: "both", description: "List spec-kit templates.", deferred: true },

  // Build Studio app control (registered in the BS app's embedded chat).
  { id: "buildstudio_artifact_open", group: "Build Studio", context: "action", description: "Open a spec artifact in the Build Studio viewer.", deferred: true },
  { id: "buildstudio_tree_refresh", group: "Build Studio", context: "action", description: "Reload the Build Studio spec tree.", deferred: true },

  // Integrations — one capability id per adapter method, following the pattern
  // `<serviceId>_<object>_<verb>` in snake_case (see actions/dispatcher.ts).
  // Example: `gmail_messages_list`, `drive_files_list`.
  //
  // GROUPING: integration capabilities are grouped per external service (not
  // under a single "Integrations" bucket) so the Settings capability picker
  // stays scannable as more providers are added. Non-Google providers should
  // use their own service-name group.
  { id: "gmail_messages_list", group: "Gmail", context: "action", description: "List Gmail messages.", deferred: true },
  { id: "gmail_messages_get", group: "Gmail", context: "action", description: "Fetch a Gmail message by id.", deferred: true },
  { id: "gmail_messages_send", group: "Gmail", context: "action", description: "Send a Gmail message.", deferred: true },
  { id: "gmail_messages_reply", group: "Gmail", context: "action", description: "Reply in-thread to a Gmail message.", deferred: true },
  { id: "gmail_messages_modify", group: "Gmail", context: "action", description: "Add or remove labels on a Gmail message.", deferred: true },
  { id: "gmail_messages_trash", group: "Gmail", context: "action", description: "Move a Gmail message to Trash.", deferred: true },
  { id: "gmail_messages_untrash", group: "Gmail", context: "action", description: "Restore a Gmail message from Trash.", deferred: true },
  { id: "gmail_messages_search", group: "Gmail", context: "action", description: "Search Gmail with Google's operator syntax.", deferred: true },
  { id: "gmail_messages_download_attachment", group: "Gmail", context: "action", description: "Download a Gmail attachment into /Documents/Emails in the VFS.", deferred: true },
  { id: "gmail_labels_list", group: "Gmail", context: "action", description: "List Gmail labels.", deferred: true },
  { id: "gmail_labels_get", group: "Gmail", context: "action", description: "Fetch a Gmail label by id.", deferred: true },
  { id: "gmail_profile_get", group: "Gmail", context: "action", description: "Fetch the authenticated Gmail profile.", deferred: true },
  { id: "drive_files_list", group: "Google Drive", context: "action", description: "List files in Google Drive.", deferred: true },
  { id: "drive_files_get", group: "Google Drive", context: "action", description: "Fetch a Drive file's metadata by id.", deferred: true },
  { id: "drive_files_search", group: "Google Drive", context: "action", description: "Search Drive with Google's query syntax.", deferred: true },
  { id: "drive_files_download", group: "Google Drive", context: "action", description: "Download a Drive file's binary content (base64, size-capped).", deferred: true },
  { id: "drive_files_export", group: "Google Drive", context: "action", description: "Export a Google-native doc (Docs/Sheets/Slides) as PDF/CSV/text/etc.", deferred: true },
  { id: "drive_folders_list", group: "Google Drive", context: "action", description: "List folders in Drive, optionally under a parent.", deferred: true },
  { id: "drive_about_get", group: "Google Drive", context: "action", description: "Fetch the authenticated Drive profile + storage quota.", deferred: true },
  { id: "calendar_calendars_list", group: "Google Calendar", context: "action", description: "List the user's calendars (primary + subscribed).", deferred: true },
  { id: "calendar_events_list", group: "Google Calendar", context: "action", description: "List events on a calendar within a time window.", deferred: true },
  { id: "calendar_events_get", group: "Google Calendar", context: "action", description: "Fetch a single calendar event by id.", deferred: true },
  { id: "calendar_events_create", group: "Google Calendar", context: "action", description: "Create a new calendar event.", deferred: true },
  { id: "calendar_events_update", group: "Google Calendar", context: "action", description: "Patch fields on an existing calendar event.", deferred: true },
  { id: "calendar_events_delete", group: "Google Calendar", context: "action", description: "Delete a calendar event.", deferred: true },
  { id: "calendar_events_respond", group: "Google Calendar", context: "action", description: "RSVP to a calendar event (accept / decline / tentative).", deferred: true },
  { id: "calendar_events_move", group: "Google Calendar", context: "action", description: "Move an event from one calendar to another.", deferred: true },
  { id: "calendar_freebusy_query", group: "Google Calendar", context: "action", description: "Query free/busy time ranges across calendars.", deferred: true },
  { id: "contacts_contacts_list", group: "Google Contacts", context: "action", description: "List the user's contacts (People API connections).", deferred: true },
  { id: "contacts_contacts_get", group: "Google Contacts", context: "action", description: "Fetch a single contact by resourceName.", deferred: true },
  { id: "contacts_contacts_search", group: "Google Contacts", context: "action", description: "Search contacts by free-text query.", deferred: true },
  ...TELEGRAM_BOT_CAPABILITIES,
];

// Group definitions for semantic search expansion (025-deferred-tool-discovery).
// A `find_tools(query)` call scores capabilities against these descriptions so
// a domain-level query (e.g. "file system operations") matches every deferred
// tool in that group, not just tools whose id/description literally match.
export const GROUP_DEFINITIONS: Record<string, { description: string }> = {
  "OS": { description: "BrowserOS shell control: opening and closing application windows, listing installed apps, browsing URLs, and changing the desktop wallpaper." },
  "Web": { description: "Web operations including search, fetching pages, and opening documents or URLs in preview windows." },
  "Files": { description: "Virtual file system operations including listing, reading, writing, deleting files and creating directories in the user's sandboxed storage." },
  "Config": { description: "Configuration and settings management for BrowserOS: listing configurable settings and updating configuration values." },
  "Agents": { description: "Sub-agent management, creation, and delegation of tasks to specialized agents." },
  "Memory": { description: "Persistent long-term memory: saving durable facts, recalling stored entries, and searching topic shards for past context." },
  "Skills": { description: "Reusable skill library management: listing, loading, saving, and self-improving skills for the assistant." },
  "Scratchpad": { description: "Conversation-scoped notes and scratchpad: creating, reading, editing, and deleting temporary notes tied to the current conversation." },
  "MCP": { description: "Model Context Protocol server integration: connecting servers, listing and searching their tools, inspecting schemas, and invoking tools." },
  "Apps": { description: "Runtime-installed application management: installing, listing, building, and uninstalling BrowserOS apps." },
  "Dev": { description: "Repo and developer operations: reading and searching BrowserOS source, git status, delegating implementation work, and running sandboxed shell commands." },
  "Docs": { description: "Documentation browsing: listing and reading BrowserOS documentation pages." },
  "Workflows": { description: "Multi-step workflow authoring and execution: creating, modifying, running, cancelling, validating, and exporting workflows." },
  "Specs": { description: "Specification artifact management for the spec-kit pipeline: listing, reading, writing, editing, and searching specs across stores." },
  "Build Studio": { description: "Build Studio app control: opening spec artifacts in the viewer and refreshing the spec tree." },
  "Gmail": { description: "Gmail integration: listing, reading, sending, replying, modifying, labeling, searching, and downloading attachments from messages." },
  "Google Drive": { description: "Google Drive integration: listing, searching, downloading, and exporting files and folders." },
  "Google Calendar": { description: "Google Calendar integration: listing calendars, reading events, creating, updating, deleting, moving, RSVPing to events, and querying free/busy times." },
  "Google Contacts": { description: "Google Contacts integration: listing, fetching, and searching contacts from the People API." },
  "Telegram": { description: "Telegram bot integration: reading bot profile and updates, sending messages and media, managing chat messages and command menus, and routing messages through BOS agents." },
};

/** Look up a group's description (used for search expansion). Falls back to a
 *  generic description if the group is unknown, so tools whose group is not yet
 *  in `GROUP_DEFINITIONS` can still be scored. */
export function groupDescription(name: string): string {
  return GROUP_DEFINITIONS[name]?.description ?? `Capabilities in the "${name}" group.`;
}

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

const ACTION_IDS = new Set(CAPABILITIES.filter((c) => c.context !== "tool").map((c) => c.id));
const DEFERRED_IDS = new Set(CAPABILITIES.filter((c) => c.deferred === true).map((c) => c.id));

/** Is this id a main-chat action? */
export function isActionId(id: string): boolean {
  return ACTION_IDS.has(id);
}

/** Is this capability deferred BY REGISTRY DEFAULT (hidden from initial context,
 *  discovered via find_tools)? Per-agent deferred lists live in each agent's
 *  AGENT.md (`deferredTools`) and are combined with this default at request
 *  boundaries in the sub-agent runner. */
export function isDeferred(id: string): boolean {
  return DEFERRED_IDS.has(id);
}

/** All capability ids marked deferred by registry default. Runners union this
 *  set with the calling agent's `deferredTools` to obtain the effective
 *  deferred set for a delegated run. */
export function deferredCapabilityIds(): Set<string> {
  return new Set(DEFERRED_IDS);
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
