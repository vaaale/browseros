// Curated list of the tools/actions available to the main assistant, shown in
// the Assistant's right side panel. Mirrors the actions registered via
// useCopilotAction across the agent action components.

export interface ToolInfo {
  group: string;
  name: string;
  description: string;
}

export const ASSISTANT_TOOLS: ToolInfo[] = [
  { group: "OS", name: "launchApp", description: "Open an application window." },
  { group: "OS", name: "closeWindow", description: "Close an open window." },
  { group: "OS", name: "listApps", description: "List installed applications." },
  { group: "OS", name: "changeWallpaper", description: "Change the desktop wallpaper." },
  { group: "OS", name: "openWebPage", description: "Open a URL in the web browser." },

  { group: "Files", name: "listFiles", description: "List a virtual file system directory." },
  { group: "Files", name: "readFile", description: "Read a text file." },
  { group: "Files", name: "writeFile", description: "Create or overwrite a text file." },
  { group: "Files", name: "createFolder", description: "Create a directory." },
  { group: "Files", name: "deletePath", description: "Delete a file or folder." },

  { group: "Config", name: "listConfigurableSettings", description: "List configurable settings." },
  { group: "Config", name: "updateSetting", description: "Update a configuration value." },

  { group: "Sub-agents", name: "listSubAgents", description: "List available sub-agents." },
  { group: "Sub-agents", name: "createSubAgent", description: "Create a reusable sub-agent." },
  { group: "Sub-agents", name: "delegateToSubAgent", description: "Delegate a task to a sub-agent." },
  { group: "Sub-agents", name: "requestClaudeAgentPermission", description: "Ask to use a Claude agent for a non-dev task." },

  { group: "Memory", name: "memory", description: "Save to persistent memory (user profile / agent notes)." },
  { group: "Memory", name: "recallMemories", description: "Read live persistent memory entries." },

  { group: "Skills", name: "loadSkill", description: "Load a skill's full instructions." },
  { group: "Skills", name: "saveSkill", description: "Save a reusable skill." },
  { group: "Skills", name: "reflectAndLearn", description: "Run the self-improvement review after a task." },
  { group: "Skills", name: "improveSkill", description: "Improve a skill from feedback (GEPA)." },
  { group: "Skills", name: "runCurator", description: "Archive stale agent-created skills (recoverable)." },

  { group: "MCP", name: "listMcpServers", description: "List connected MCP servers." },
  { group: "MCP", name: "addMcpServer", description: "Connect an MCP server." },
  { group: "MCP", name: "removeMcpServer", description: "Disconnect an MCP server." },
  { group: "MCP", name: "probeMcpServer", description: "Test an MCP server and list its tools." },

  { group: "Dev", name: "installApp", description: "Install an app from generated HTML (adds it to the dock and opens it)." },
  { group: "Dev", name: "buildApp", description: "Build & install a multi-file TS/TSX app project (esbuild) from a developer staging dir." },
  { group: "Dev", name: "listInstalledApps", description: "List runtime-installed apps." },
  { group: "Dev", name: "uninstallApp", description: "Uninstall an app." },
  { group: "Dev", name: "startFeatureBranch", description: "Start a git feature branch before BOS changes." },
  { group: "Dev", name: "stageChanges", description: "Stage changed files." },
  { group: "Dev", name: "gitStatus", description: "Show git branch and changes." },

  { group: "Docs", name: "listDocs", description: "List documentation pages (usage + dev trees)." },
  { group: "Docs", name: "readDoc", description: "Read a documentation page by ref, e.g. usage/apps/files.md." },

  { group: "Assistant", name: "switchAssistantAgent", description: "Switch the active assistant agent (personality)." },
  { group: "Assistant", name: "getMyInstructions", description: "Read the active composed instructions." },
  { group: "Assistant", name: "updateMyInstructions", description: "Rewrite the active agent's instructions." },

  { group: "Workflows", name: "createWorkflow", description: "Generate a workflow from a natural-language task description." },
  { group: "Workflows", name: "modifyWorkflow", description: "Apply a JSON-merge patch to an existing workflow." },
  { group: "Workflows", name: "runWorkflow", description: "Execute a workflow and stream step events." },
  { group: "Workflows", name: "getStatus", description: "Read a workflow's current execution state." },
  { group: "Workflows", name: "cancelWorkflow", description: "Cancel a running workflow." },
  { group: "Workflows", name: "exportWorkflow", description: "Return a workflow's full JSON." },
  { group: "Workflows", name: "validateWorkflow", description: "Validate a workflow's DAG, agents, and dependencies." },
];
