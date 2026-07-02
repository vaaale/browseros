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

export const CAPABILITIES: Capability[] = [
  // OS (actions)
  { id: "launchApp", group: "OS", context: "action", description: "Open an application window." },
  { id: "closeWindow", group: "OS", context: "action", description: "Close an open window." },
  { id: "listApps", group: "OS", context: "action", description: "List installed applications." },
  { id: "changeWallpaper", group: "OS", context: "action", description: "Change the desktop wallpaper." },
  { id: "openWebPage", group: "OS", context: "action", description: "Open a URL in the web browser." },
  { id: "openPreview", group: "OS", context: "action", description: "Open an HTML document or URL in a sandboxed preview window." },

  // Files (actions = user VFS; tools = sub-agent VFS)
  { id: "listFiles", group: "Files", context: "action", description: "List a virtual file system directory." },
  { id: "readFile", group: "Files", context: "action", description: "Read a text file." },
  { id: "writeFile", group: "Files", context: "action", description: "Create or overwrite a text file." },
  { id: "createFolder", group: "Files", context: "action", description: "Create a directory." },
  { id: "deletePath", group: "Files", context: "action", description: "Delete a file or folder." },
  { id: "list_files", group: "Files", context: "tool", description: "List a VFS directory (sub-agent)." },
  { id: "read_file", group: "Files", context: "tool", description: "Read a text file (sub-agent)." },
  { id: "write_file", group: "Files", context: "tool", description: "Write a text file (sub-agent)." },
  { id: "create_folder", group: "Files", context: "tool", description: "Create a directory (sub-agent)." },
  { id: "web_fetch", group: "Files", context: "tool", description: "Fetch a URL (sub-agent)." },

  // Web
  { id: "webSearch", group: "Web", context: "action", description: "Search the web with Anthropic native web search." },
  { id: "web_search", group: "Web", context: "tool", description: "Search the web with Anthropic native web search (sub-agent)." },

  // Config
  { id: "listConfigurableSettings", group: "Config", context: "action", description: "List configurable settings." },
  { id: "updateSetting", group: "Config", context: "action", description: "Update a configuration value." },

  // Agents (delegation)
  { id: "listSubAgents", group: "Agents", context: "action", description: "List available agents." },
  { id: "createSubAgent", group: "Agents", context: "action", description: "Create a reusable agent." },
  { id: "delegateToSubAgent", group: "Agents", context: "action", description: "Delegate a task to an agent." },
  { id: "requestClaudeAgentPermission", group: "Agents", context: "action", description: "Ask to use a Claude agent for a non-dev task." },
  { id: "requestFeatureBranch", group: "Agents", context: "action", description: "Set up the active feature branch needed to modify BOS source." },
  { id: "delegate_to_developer", group: "Agents", context: "tool", description: "Delegate implementation to the Developer (from a delegated agent)." },

  // Memory
  { id: "memory", group: "Memory", context: "action", description: "Save to persistent memory." },
  { id: "recallMemories", group: "Memory", context: "action", description: "Read live persistent memory entries." },

  // Skills
  { id: "loadSkill", group: "Skills", context: "action", description: "Load a skill's full instructions." },
  { id: "saveSkill", group: "Skills", context: "action", description: "Save a reusable skill." },
  { id: "reflectAndLearn", group: "Skills", context: "action", description: "Run the self-improvement review after a task." },
  { id: "improveSkill", group: "Skills", context: "action", description: "Improve a skill from feedback (GEPA)." },
  { id: "runCurator", group: "Skills", context: "action", description: "Archive stale agent-created skills (recoverable)." },

  // MCP
  { id: "listMcpServers", group: "MCP", context: "action", description: "List connected MCP servers (with descriptions)." },
  { id: "searchMcpTools", group: "MCP", context: "action", description: "Search MCP tools across all servers or on a specific server." },
  { id: "listMcpServerTools", group: "MCP", context: "action", description: "List a server's tools with their input schemas." },
  { id: "getMcpToolSchema", group: "MCP", context: "action", description: "Get the input JSON schema for a single MCP tool." },
  { id: "callMcpTool", group: "MCP", context: "action", description: "Call a tool on an MCP server with schema-validated arguments." },
  { id: "findTools", group: "MCP", context: "action", description: "Search MCP tools across all servers (legacy alias for searchMcpTools)." },
  { id: "callMcpServerTool", group: "MCP", context: "action", description: "Call a tool on an MCP server (legacy alias for callMcpTool)." },
  { id: "addMcpServer", group: "MCP", context: "action", description: "Connect an MCP server." },
  { id: "removeMcpServer", group: "MCP", context: "action", description: "Disconnect an MCP server." },

  // Dev (apps + repo)
  { id: "installApp", group: "Dev", context: "action", description: "Install an app from generated HTML." },
  { id: "buildApp", group: "Dev", context: "action", description: "Build & install a multi-file TS/TSX app project." },
  { id: "listInstalledApps", group: "Dev", context: "action", description: "List runtime-installed apps." },
  { id: "uninstallApp", group: "Dev", context: "action", description: "Uninstall an app." },
  { id: "gitStatus", group: "Dev", context: "action", description: "Show git branch and changes (read-only)." },
  { id: "list_source", group: "Dev", context: "tool", description: "List repo source (sub-agent)." },
  { id: "read_source", group: "Dev", context: "tool", description: "Read repo source (sub-agent)." },
  { id: "search_source", group: "Dev", context: "tool", description: "Search repo source (sub-agent)." },
  { id: "write_source", group: "Dev", context: "tool", description: "Write repo source (sub-agent)." },
  { id: "edit_source", group: "Dev", context: "tool", description: "Edit repo source (sub-agent)." },
  { id: "run_command", group: "Dev", context: "tool", description: "Run an allowlisted command (sub-agent)." },
  { id: "git_status", group: "Dev", context: "tool", description: "Git status (sub-agent, read-only)." },

  // Docs
  { id: "listDocs", group: "Docs", context: "action", description: "List documentation pages." },
  { id: "readDoc", group: "Docs", context: "action", description: "Read a documentation page by ref." },

  // Assistant
  { id: "switchAssistantAgent", group: "Assistant", context: "action", description: "Switch the active assistant agent." },
  { id: "getMyInstructions", group: "Assistant", context: "action", description: "Read the active agent's editable personality." },
  { id: "updateMyInstructions", group: "Assistant", context: "action", description: "Rewrite the active agent's personality." },

  // Workflows
  { id: "createWorkflow", group: "Workflows", context: "action", description: "Generate a workflow from a description." },
  { id: "modifyWorkflow", group: "Workflows", context: "action", description: "Apply a JSON-merge patch to a workflow." },
  { id: "runWorkflow", group: "Workflows", context: "action", description: "Execute a workflow and stream step events." },
  { id: "getStatus", group: "Workflows", context: "action", description: "Read a workflow's execution state." },
  { id: "cancelWorkflow", group: "Workflows", context: "action", description: "Cancel a running workflow." },
  { id: "exportWorkflow", group: "Workflows", context: "action", description: "Return a workflow's full JSON." },
  { id: "validateWorkflow", group: "Workflows", context: "action", description: "Validate a workflow's DAG." },

  // Specs (client actions mirror the server spec tools, so an active-personality
  // agent like Build Studio authors specs directly — 016 FR-006).
  { id: "listSpecs", group: "Specs", context: "action", description: "List spec artifacts under specs/." },
  { id: "readSpec", group: "Specs", context: "action", description: "Read a spec artifact." },
  { id: "writeSpec", group: "Specs", context: "action", description: "Create/overwrite a spec artifact (specs/ + .specify/)." },
  { id: "editSpec", group: "Specs", context: "action", description: "Find/replace within a spec artifact." },
  { id: "searchSpecs", group: "Specs", context: "action", description: "Search spec artifacts." },
  { id: "list_specs", group: "Specs", context: "tool", description: "List spec artifacts (sub-agent)." },
  { id: "read_spec", group: "Specs", context: "tool", description: "Read a spec artifact (sub-agent)." },
  { id: "write_spec", group: "Specs", context: "tool", description: "Write a spec artifact (sub-agent)." },
  { id: "edit_spec", group: "Specs", context: "tool", description: "Edit a spec artifact (sub-agent)." },
  { id: "search_specs", group: "Specs", context: "tool", description: "Search spec artifacts (sub-agent)." },
  { id: "read_template", group: "Specs", context: "tool", description: "Read a spec-kit template/command prompt (sub-agent)." },
  { id: "list_templates", group: "Specs", context: "tool", description: "List spec-kit templates (sub-agent)." },

  // Build Studio app control (registered in the BS app's embedded chat).
  { id: "openSpecArtifact", group: "Build Studio", context: "action", description: "Open a spec artifact in the Build Studio viewer." },
  { id: "refreshSpecTree", group: "Build Studio", context: "action", description: "Reload the Build Studio spec tree." },
];

// Tools/actions the UI marks with a warning affordance in the Agent Settings
// capability picker. Kept as a UI-layer hardcoded list rather than a field on
// Capability so the registry stays a pure inventory (the "danger" judgement is
// presentational, not a property of the tool). Add ids here to opt into the
// warning styling — matching happens by exact id against the capability id.
const DANGEROUS_TOOL_NAMES: readonly string[] = [
  "delete_path", // sub-agent VFS delete (spec/mockup example)
  "deletePath", // corresponding main-chat action id
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
