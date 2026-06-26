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

  { group: "Memory", name: "rememberThis", description: "Save a durable memory." },
  { group: "Memory", name: "recallMemories", description: "Search long-term memory." },

  { group: "Skills", name: "loadSkill", description: "Load a skill's full instructions." },
  { group: "Skills", name: "saveSkill", description: "Save a reusable skill." },
  { group: "Skills", name: "reflectAndLearn", description: "Reflect after a task; record memories / skills." },
  { group: "Skills", name: "improveSkill", description: "Improve a skill from feedback (GEPA)." },

  { group: "MCP", name: "listMcpServers", description: "List connected MCP servers." },
  { group: "MCP", name: "addMcpServer", description: "Connect an MCP server." },
  { group: "MCP", name: "removeMcpServer", description: "Disconnect an MCP server." },
  { group: "MCP", name: "probeMcpServer", description: "Test an MCP server and list its tools." },

  { group: "Dev", name: "installApp", description: "Install an app from generated HTML (adds it to the dock and opens it)." },
  { group: "Dev", name: "listInstalledApps", description: "List runtime-installed apps." },
  { group: "Dev", name: "uninstallApp", description: "Uninstall an app." },
  { group: "Dev", name: "startFeatureBranch", description: "Start a git feature branch before BOS changes." },
  { group: "Dev", name: "stageChanges", description: "Stage changed files." },
  { group: "Dev", name: "gitStatus", description: "Show git branch and changes." },

  { group: "Docs", name: "listDocs", description: "List documentation pages." },
  { group: "Docs", name: "readDoc", description: "Read a documentation page." },
  { group: "Docs", name: "writeDoc", description: "Create/update a documentation page." },

  { group: "Assistant", name: "listProfiles", description: "List personality profiles." },
  { group: "Assistant", name: "switchProfile", description: "Switch the active profile." },
  { group: "Assistant", name: "getMyInstructions", description: "Read the active instructions." },
  { group: "Assistant", name: "updateMyInstructions", description: "Rewrite the active profile instructions." },
];
