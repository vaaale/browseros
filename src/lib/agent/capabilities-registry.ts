// Single source of truth for agent capabilities (016-unified-agents).
//
// One "agent" has one allowlist (`tools`) that governs it in BOTH contexts:
//  - context "action" → a main-chat CopilotKit action (id = the useCopilotAction
//    name); gated client-side via the `available` flag (see gated-action.ts).
//  - context "tool"   → a server sub-agent tool (id = the toolsFor() key); gated
//    server-side in runner.ts.
//  - context "both"   → exists in both (e.g. spec ops: a client action + a server tool).
//
// Framework-free (no react, no server-only) so client gating, the server tool
// resolver, the Settings catalog, and the InfoPanel all read the same list.

export type CapabilityContext = "action" | "tool" | "both";

export interface Capability {
  id: string;
  group: string;
  description: string;
  context: CapabilityContext;
}

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
  { id: "web_fetch", group: "Web", context: "tool", description: "Fetch a URL's readable text (sub-agent)." },
  { id: "web_view", group: "Web", context: "action", description: "Open an HTML document or URL in a sandboxed preview window." },

  // Files (VFS) — one id per op, used by the main chat and delegated sub-agents.
  { id: "file_list", group: "Files", context: "both", description: "List a virtual file system directory." },
  { id: "file_read", group: "Files", context: "both", description: "Read a text file." },
  { id: "file_write", group: "Files", context: "both", description: "Create or overwrite a text file." },
  { id: "file_mkdir", group: "Files", context: "both", description: "Create a directory." },
  { id: "file_delete", group: "Files", context: "action", description: "Delete a file or folder." },

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
  { id: "memory_save", group: "Memory", context: "action", description: "Save to persistent memory." },
  { id: "memory_recall", group: "Memory", context: "action", description: "Read live persistent memory entries." },

  // Skills
  { id: "skill_list", group: "Skills", context: "both", description: "List available skills." },
  { id: "skill_load", group: "Skills", context: "both", description: "Load a skill's full instructions." },
  { id: "skill_read_file", group: "Skills", context: "both", description: "Read a bundled reference/script file from a skill." },
  { id: "skill_save", group: "Skills", context: "action", description: "Save a reusable skill." },
  { id: "skill_reflect", group: "Skills", context: "action", description: "Run the self-improvement review after a task." },
  { id: "skill_improve", group: "Skills", context: "action", description: "Improve a skill from feedback (GEPA)." },
  { id: "skill_curate", group: "Skills", context: "action", description: "Archive stale agent-created skills (recoverable)." },

  // MCP
  { id: "mcp_server_list", group: "MCP", context: "action", description: "List connected MCP servers (with descriptions)." },
  { id: "mcp_tool_search", group: "MCP", context: "action", description: "Search MCP tools across all servers or on a specific server." },
  { id: "mcp_server_tools", group: "MCP", context: "action", description: "List a server's tools with their input schemas." },
  { id: "mcp_tool_schema", group: "MCP", context: "action", description: "Get the input JSON schema for a single MCP tool." },
  { id: "mcp_tool_call", group: "MCP", context: "action", description: "Call a tool on an MCP server with schema-validated arguments." },
  { id: "mcp_server_add", group: "MCP", context: "action", description: "Connect an MCP server." },
  { id: "mcp_server_remove", group: "MCP", context: "action", description: "Disconnect an MCP server." },

  // Apps (runtime-installed apps)
  { id: "app_install", group: "Apps", context: "action", description: "Install an app from generated HTML." },
  { id: "app_build", group: "Apps", context: "action", description: "Build & install a multi-file TS/TSX app project." },
  { id: "app_list", group: "Apps", context: "action", description: "List runtime-installed apps." },
  { id: "app_uninstall", group: "Apps", context: "action", description: "Uninstall an app." },

  // Dev (repo + harness)
  { id: "dev_git_status", group: "Dev", context: "both", description: "Show git branch and changes (read-only)." },
  { id: "dev_branch_request", group: "Dev", context: "action", description: "Set up the active feature branch needed to modify BOS source." },
  { id: "dev_delegate", group: "Dev", context: "tool", description: "Delegate implementation to the Developer (from a delegated agent)." },
  { id: "bos_source_list", group: "Dev", context: "tool", description: "List BOS source (read-only, sub-agent)." },
  { id: "bos_source_read", group: "Dev", context: "tool", description: "Read a BOS source file (read-only, sub-agent)." },
  { id: "bos_source_search", group: "Dev", context: "tool", description: "Search BOS source (read-only, sub-agent)." },
  { id: "run_command", group: "Dev", context: "both", description: "Run a command in a sandboxed environment (bash/python/node)." },

  // Docs
  { id: "docs_list", group: "Docs", context: "action", description: "List documentation pages." },
  { id: "docs_read", group: "Docs", context: "action", description: "Read a documentation page by ref." },

  // Workflows
  { id: "workflow_create", group: "Workflows", context: "action", description: "Generate a workflow from a description." },
  { id: "workflow_modify", group: "Workflows", context: "action", description: "Apply a JSON-merge patch to a workflow." },
  { id: "workflow_run", group: "Workflows", context: "action", description: "Execute a workflow and stream step events." },
  { id: "workflow_status", group: "Workflows", context: "action", description: "Read a workflow's execution state." },
  { id: "workflow_cancel", group: "Workflows", context: "action", description: "Cancel a running workflow." },
  { id: "workflow_export", group: "Workflows", context: "action", description: "Return a workflow's full JSON." },
  { id: "workflow_validate", group: "Workflows", context: "action", description: "Validate a workflow's DAG." },

  // Specs (one id per op, used by the main chat and delegated sub-agents).
  { id: "spec_list", group: "Specs", context: "both", description: "List spec artifacts under a store." },
  { id: "spec_read", group: "Specs", context: "both", description: "Read a spec artifact." },
  { id: "spec_write", group: "Specs", context: "both", description: "Create/overwrite a spec artifact." },
  { id: "spec_edit", group: "Specs", context: "both", description: "Find/replace within a spec artifact." },
  { id: "spec_search", group: "Specs", context: "both", description: "Search spec artifacts." },
  { id: "spec_template_read", group: "Specs", context: "tool", description: "Read a spec-kit template/command prompt (sub-agent)." },
  { id: "spec_template_list", group: "Specs", context: "tool", description: "List spec-kit templates (sub-agent)." },

  // Build Studio app control (registered in the BS app's embedded chat).
  { id: "buildstudio_artifact_open", group: "Build Studio", context: "action", description: "Open a spec artifact in the Build Studio viewer." },
  { id: "buildstudio_tree_refresh", group: "Build Studio", context: "action", description: "Reload the Build Studio spec tree." },

  // Integrations — one capability id per adapter method, following the pattern
  // `<integrationId>_<serviceId>_<method>` (see actions/dispatcher.ts).
  //
  // NAMING EXCEPTION: everywhere else the standard is `subsystem_object_verb`
  // in snake_case. Adapter methods here keep their original camelCase (e.g.
  // `listMessages`) because these are pass-through wrappers over provider
  // SDKs — matching the provider vocabulary makes it easier for the LLM to
  // apply examples from Gmail/Drive/Calendar docs directly. Grep for
  // `NAMING EXCEPTION` before adding new integration ids.
  { id: "gsuite_gmail_listMessages", group: "Integrations", context: "action", description: "List Gmail messages." },
  { id: "gsuite_gmail_getMessage", group: "Integrations", context: "action", description: "Fetch a Gmail message by id." },
  { id: "gsuite_gmail_sendMessage", group: "Integrations", context: "action", description: "Send a Gmail message." },
  { id: "gsuite_gmail_replyToMessage", group: "Integrations", context: "action", description: "Reply in-thread to a Gmail message." },
  { id: "gsuite_gmail_modifyMessage", group: "Integrations", context: "action", description: "Add or remove labels on a Gmail message." },
  { id: "gsuite_gmail_trashMessage", group: "Integrations", context: "action", description: "Move a Gmail message to Trash." },
  { id: "gsuite_gmail_untrashMessage", group: "Integrations", context: "action", description: "Restore a Gmail message from Trash." },
  { id: "gsuite_gmail_searchMessages", group: "Integrations", context: "action", description: "Search Gmail with Google's operator syntax." },
  { id: "gsuite_gmail_listLabels", group: "Integrations", context: "action", description: "List Gmail labels." },
  { id: "gsuite_gmail_getLabel", group: "Integrations", context: "action", description: "Fetch a Gmail label by id." },
  { id: "gsuite_gmail_getProfile", group: "Integrations", context: "action", description: "Fetch the authenticated Gmail profile." },
];

// Tools/actions the UI marks with a warning affordance in the Agent Settings
// capability picker. Kept as a UI-layer hardcoded list rather than a field on
// Capability so the registry stays a pure inventory (the "danger" judgement is
// presentational, not a property of the tool). Add ids here to opt into the
// warning styling — matching happens by exact id against the capability id.
const DANGEROUS_TOOL_NAMES: readonly string[] = [
  "file_delete", // destructive VFS delete
  "run_command", // arbitrary command execution (sandboxed, but still powerful)
];

/** Ids the UI should annotate as dangerous (warning icon + red description). */
export function getDangerousToolNames(): readonly string[] {
  return DANGEROUS_TOOL_NAMES;
}

const ACTION_IDS = new Set(CAPABILITIES.filter((c) => c.context !== "tool").map((c) => c.id));

/** Is this id a main-chat action (gated client-side)? */
export function isActionId(id: string): boolean {
  return ACTION_IDS.has(id);
}

// The per-agent action gate (016). Back-compat rule: an action is allowed UNLESS
// the agent's allowlist names ≥1 action id and this one isn't among them. So an
// unset/empty allowlist — or a legacy allowlist of only server *tool* ids — leaves
// every action enabled (no agent silently loses actions on upgrade). Pure +
// framework-free so the client provider and tests share one source of truth.
export function resolveActionGate(allow: string[] | null | undefined): (id: string) => boolean {
  const named = (allow ?? []).filter(isActionId);
  if (named.length === 0) return () => true;
  const set = new Set(named);
  return (id) => set.has(id);
}

/** All capabilities that surface as main-chat actions. */
export function actionCapabilities(): Capability[] {
  return CAPABILITIES.filter((c) => c.context !== "tool");
}
