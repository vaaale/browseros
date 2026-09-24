// Tool groups (041-tool-groups) — the single source of truth for what a group
// IS: a stable id, a display name, a description, and curated search aliases.
//
// Framework-free (no react, no server-only) so the prompt builder, the ranking
// module, the discovery tool, the Settings catalog and the tests all read one
// list. Deliberately imports NOTHING from capabilities-registry.ts: a group
// owns no tools, tools reference a group by id, and membership is always
// computed by the caller. That is what keeps the two modules cycle-free.
//
// Identity is the `id`, never the display name (ADR-1). A user override, a
// service declaration and a capability all key off the id, so renaming a
// group's `name` never orphans anything.
//
// THERE IS NO FALLBACK GROUP (FR-041). A capability whose group id does not
// resolve is a bug to surface, not a thing to bucket — see `resolveGroup` and
// `groupById`, neither of which invents anything.

export type ToolGroupOrigin = "builtin" | "service";

export interface ToolGroup {
  /** Stable slug. The join key for capabilities, overrides and declarations. */
  id: string;
  /** Human-facing label. Rendered uppercase in the prompt; stored as written. */
  name: string;
  /** One line, used by BOTH the prompt block and search ranking (FR-002). */
  description: string;
  /** Curated search vocabulary the description doesn't use (FR-020). */
  aliases: string[];
  origin: ToolGroupOrigin;
}

/** The built-in groups, IN CANONICAL ORDER. This array's order is the display
 *  and prompt order (FR-012) — previously an accident of first-seen capability
 *  order. Dynamic (service) groups always sort after these. */
export const BUILTIN_TOOL_GROUPS: readonly ToolGroup[] = [
  {
    id: "os",
    name: "OS",
    description:
      "BrowserOS shell control: opening and closing application windows, listing installed apps, browsing URLs, and changing the desktop wallpaper.",
    aliases: ["desktop", "window", "wallpaper", "launch", "shell"],
    origin: "builtin",
  },
  {
    id: "web",
    name: "Web",
    description:
      "Web operations including search, fetching pages, and opening documents or URLs in preview windows.",
    aliases: ["internet", "online", "browse", "url", "website", "page", "research"],
    origin: "builtin",
  },
  {
    id: "files",
    name: "Files",
    description:
      "Virtual file system operations including listing, reading, writing, editing, patching, searching, and globbing files, and creating/deleting directories — including mounted paths like /Specs, /Docs, and /Methods/<method-id>/templates. Also converts documents to markdown and views images and video frames.",
    aliases: ["folder", "directory", "document", "pdf", "docx", "spreadsheet", "image", "video", "vfs"],
    origin: "builtin",
  },
  {
    id: "config",
    name: "Config",
    description:
      "Configuration and settings management for BrowserOS: listing configurable settings and updating configuration values.",
    aliases: ["settings", "preferences", "options"],
    origin: "builtin",
  },
  {
    id: "agents",
    name: "Agents",
    description: "Sub-agent management, creation, and delegation of tasks to specialized agents.",
    aliases: ["delegate", "subagent", "sub-agent", "personality", "assistant"],
    origin: "builtin",
  },
  {
    id: "conversation-review",
    name: "Conversation Review",
    description:
      "Auditing a past conversation's behavior: reading it in verifiable pages and submitting a findings report proposing agent/skill/doc improvements.",
    aliases: ["transcript", "audit", "history", "past chat", "retrospective"],
    origin: "builtin",
  },
  {
    id: "memory",
    name: "Memory",
    description:
      "Persistent long-term memory: saving durable facts, recalling stored entries, and searching topic shards for past context.",
    aliases: ["remember", "recall", "forget", "note to self", "long-term"],
    origin: "builtin",
  },
  {
    id: "skills",
    name: "Skills",
    description:
      "Reusable skill library management: listing, loading, saving, and self-improving skills for the assistant.",
    aliases: ["instructions", "playbook", "procedure", "how-to", "learn"],
    origin: "builtin",
  },
  {
    id: "scratchpad",
    name: "Scratchpad",
    description:
      "Conversation-scoped notes and scratchpad: creating, reading, editing, and deleting temporary notes tied to the current conversation.",
    aliases: ["notes", "jot", "draft", "working memory", "todo"],
    origin: "builtin",
  },
  {
    id: "mcp",
    name: "MCP",
    description:
      "Model Context Protocol server integration: connecting servers, listing and searching their tools, inspecting schemas, and invoking tools. NOTE: an MCP server's own tools are reached through these gateway tools, never through find_tools.",
    aliases: ["model context protocol", "external tools", "connector", "server"],
    origin: "builtin",
  },
  {
    id: "apps",
    name: "Apps",
    description:
      "Runtime-installed application management: installing, listing, building, and uninstalling BrowserOS apps.",
    aliases: ["install", "uninstall", "marketplace", "application", "build app"],
    origin: "builtin",
  },
  {
    id: "specs",
    name: "Specs",
    description:
      "Marketplace-item specifications: creating, listing, reading, and editing the spec that lives inside an item's own folder — distinct from BOS-core/user specs, which use the file_* tools on /Specs/ instead.",
    aliases: ["specification", "requirements", "spec-kit", "openspec", "bmad", "spec method", "feature spec"],
    origin: "builtin",
  },
  {
    id: "methods",
    name: "Methods",
    description:
      "Spec METHODS themselves — the pipelines a spec follows: which methods are installed, what phases each declares and in what sequence, which driver skill runs one, forking a pack's method to make it yours, and editing a fork's structure or a phase's prompt. About the PROCESS, not any one feature's spec.",
    aliases: ["method pack", "workflow", "pipeline", "phases", "spec-kit", "bmad", "openspec", "fork", "driver skill", "gates"],
    origin: "builtin",
  },
  {
    id: "dev",
    name: "Dev",
    description:
      "Repo and developer operations: reading and searching BrowserOS source, git status, delegating implementation work, and running sandboxed shell commands.",
    aliases: ["source code", "git", "branch", "repository", "shell", "terminal", "command"],
    origin: "builtin",
  },
  {
    id: "conflict-resolution",
    name: "Conflict Resolution",
    description:
      "Resolving a git merge conflict in an active conflict-resolution session: reading the ours/base/theirs content of conflicting files, writing resolved content back, escalating genuinely ambiguous hunks to the user, and completing or abandoning the underlying git operation.",
    aliases: ["merge conflict", "rebase", "ours", "theirs", "reconcile"],
    origin: "builtin",
  },
  {
    id: "self-heal",
    name: "Self Heal",
    description:
      "BrowserOS's self-healing mechanism: reporting a problem for autonomous diagnosis, submitting a diagnostics report, asking the user a question the autonomous fix pipeline cannot decide, and declaring a fix ready for review.",
    aliases: ["self-healing", "diagnose", "diagnostician", "healing case", "auto-fix", "report a problem", "gap"],
    origin: "builtin",
  },
  {
    id: "scheduler",
    name: "Scheduler",
    description:
      "Scheduled and recurring jobs: listing, creating, updating, pausing, resuming, deleting scheduled tasks, changing a job's schedule, and running one immediately.",
    aliases: ["cron", "recurring", "timer", "periodic", "automation", "job", "later"],
    origin: "builtin",
  },
  {
    id: "build-studio",
    name: "Build Studio",
    description:
      "Build Studio app control: opening spec artifacts in the viewer, highlighting a section, refreshing the spec tree, and running a feature's e2e tests.",
    aliases: ["spec viewer", "artifact", "pipeline"],
    origin: "builtin",
  },
  {
    id: "ui-preview",
    name: "UI Preview",
    description:
      "Live A2UI mockup design surface: opening the UI Preview window, generating and pushing A2UI operations, and scrolling the paired spec viewer to a requirement.",
    aliases: ["mockup", "wireframe", "design surface", "prototype"],
    origin: "builtin",
  },
  {
    id: "gmail",
    name: "Gmail",
    description:
      "Gmail integration: listing, reading, sending, replying, modifying, labeling, searching, and downloading attachments from messages.",
    aliases: ["email", "e-mail", "mail", "inbox", "message", "reply", "attachment"],
    origin: "builtin",
  },
  {
    id: "google-drive",
    name: "Google Drive",
    description: "Google Drive integration: listing, searching, downloading, and exporting files and folders.",
    aliases: ["drive", "cloud storage", "google doc", "sheet", "spreadsheet", "shared folder"],
    origin: "builtin",
  },
  {
    id: "google-calendar",
    name: "Google Calendar",
    description:
      "Google Calendar integration: listing calendars, reading events, creating, updating, deleting, moving, RSVPing to events, and querying free/busy times.",
    aliases: ["calendar", "meeting", "appointment", "event", "schedule", "availability", "invite"],
    origin: "builtin",
  },
  {
    id: "google-contacts",
    name: "Google Contacts",
    description: "Google Contacts integration: listing, fetching, and searching contacts from the People API.",
    aliases: ["contact", "address book", "person", "people", "phone number"],
    origin: "builtin",
  },
  {
    id: "telegram",
    name: "Telegram",
    description:
      "Telegram bot integration: reading bot profile and updates, sending messages and media, managing chat messages and command menus, and routing messages through BOS agents.",
    aliases: ["bot", "chat", "messaging", "dm"],
    origin: "builtin",
  },
];

// ── Dynamic layer ───────────────────────────────────────────────────────────
// Service-declared groups (041 ADR-5) register here when their service starts
// and unregister when its last tool goes. Backed by globalThis so it survives
// HMR re-evaluation, exactly like capabilities-registry's dynamic capabilities.

const DYNAMIC_GROUPS_KEY = "__bos_dynamic_tool_groups__" as const;

function getDynamicGroups(): ToolGroup[] {
  const g = globalThis as Record<string, unknown>;
  if (!Array.isArray(g[DYNAMIC_GROUPS_KEY])) g[DYNAMIC_GROUPS_KEY] = [];
  return g[DYNAMIC_GROUPS_KEY] as ToolGroup[];
}

/** Register (or replace) service-declared groups. Idempotent per id, so a
 *  service restart re-declaring the same groups is a no-op update. */
export function registerToolGroups(groups: ToolGroup[]): void {
  const dynamic = getDynamicGroups();
  for (const group of groups) {
    const idx = dynamic.findIndex((g) => g.id === group.id);
    if (idx !== -1) dynamic[idx] = group;
    else dynamic.push(group);
  }
}

/** Drop dynamic groups by id — called when a group's last member capability is
 *  unregistered (FR-004). Persisted user overrides are NOT touched: they live
 *  in tool-group-overrides.ts and must survive a stopped service (FR-049). */
export function unregisterToolGroups(ids: string[]): void {
  const dynamic = getDynamicGroups();
  const remove = new Set(ids);
  const keep = dynamic.filter((g) => !remove.has(g.id));
  dynamic.length = 0;
  dynamic.push(...keep);
}

/** Every live group: built-ins in canonical order, then dynamic groups sorted
 *  by id. The ordering is total and stable so the prompt's cacheable prefix
 *  doesn't shuffle when a service restarts (FR-012). */
export function listToolGroups(): ToolGroup[] {
  const dynamic = [...getDynamicGroups()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return [...BUILTIN_TOOL_GROUPS, ...dynamic];
}

/** Exact lookup by id. Returns undefined for an unknown id — callers MUST
 *  treat that as an error to surface, never as a reason to synthesize a group
 *  (FR-041). */
export function groupById(id: string): ToolGroup | undefined {
  return listToolGroups().find((g) => g.id === id);
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Tolerant group lookup for a model-supplied string (FR-030), with a FIXED
 * precedence so the result never depends on registration order:
 *
 *   1. exact id
 *   2. normalized id (case/whitespace/`-`/`_`/space-insensitive)
 *   3. normalized display name
 *   4. normalized alias
 *
 * The first tier that yields a match wins, and within a tier the first group in
 * `listToolGroups()` order wins. So an alias that collides with another group's
 * id always loses to the id — deterministically, with no guessing between
 * candidates. Returns undefined when nothing matches; the caller reports the
 * available groups rather than falling back (FR-032).
 */
export function resolveGroup(query: string): ToolGroup | undefined {
  const raw = (query ?? "").trim();
  if (!raw) return undefined;
  const groups = listToolGroups();
  const slug = (s: string) => normalize(s).replace(/[\s_-]+/g, "");
  const q = normalize(raw);
  const qs = slug(raw);

  return (
    groups.find((g) => g.id === raw) ??
    groups.find((g) => slug(g.id) === qs) ??
    groups.find((g) => normalize(g.name) === q || slug(g.name) === qs) ??
    groups.find((g) => g.aliases.some((a) => normalize(a) === q || slug(a) === qs))
  );
}
