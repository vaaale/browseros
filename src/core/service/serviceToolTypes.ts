// Service tool types — framework-free (no server-only import), shared between
// the ServiceToolBridge (src/lib/agent/service-tool-bridge.ts), ServiceManager,
// worker entrypoints, and test fixtures. See
// specs/user-specs/039-service-tool-exposure/design.md §4.1/§5 for the full
// architecture — a service declares tools at startup (tool_declare, worker IPC)
// and BOS invokes them (tool_call/tool_result/tool_error), all keyed by callId.

/** Canonical logging component for every module in this feature (T004) —
 *  distinct from ServiceManager's own "services.manager" component and from
 *  its raw worker stdout/stderr capture (`appendServiceLog`). */
export const LOG = "services.tool-bridge";

/** A tool GROUP a service contributes (041-tool-groups, ADR-5). Declared once
 *  in `service.json` (`ServiceManifest.toolGroups`) so there is exactly one
 *  authored description per group, and validated at INSTALL time rather than at
 *  first start.
 *
 *  COMPILE-TIME TYPE ONLY — an installed item's worker runs unbundled, outside
 *  the `@/` module graph, and cannot import any BOS-source TypeScript module.
 *  An item declares a group by writing plain JSON in its manifest and, per tool,
 *  by putting a plain string in the `group` field of the object literal it posts
 *  over `tool_declare`. This type exists so BOS's own side of that boundary is
 *  checked. (The module header's "shared with worker entrypoints" is true only
 *  for BOS's own in-repo test fixtures.) */
export interface ToolGroupDeclaration {
  /** Stable slug, e.g. "workflows". The join key for capabilities and for the
   *  user's persisted group overrides. */
  id: string;
  /** Human-facing label, e.g. "Workflows". */
  name: string;
  /** One line, used by BOTH the system-prompt tool-group block and find_tools
   *  ranking — there is no second place to author this. */
  description: string;
  /** Optional curated search vocabulary the description doesn't use. */
  aliases?: string[];
}

/** A tool a service declares at startup: a name, description, and input
 *  JSON-schema — mirrors the shape the assistant's `AssistantTool` registry
 *  expects (src/lib/assistant/tools.ts), minus the executor. */
export interface ToolDeclaration {
  name: string;
  description: string;
  /** JSON Schema describing the tool's input arguments. */
  inputSchema: Record<string, unknown>;
  /** Which of the service's declared `toolGroups` this tool belongs to (041
   *  FR-038). Optional only when the manifest declares exactly one group, which
   *  is then implied; with several declared, omitting this is an error, not a
   *  thing to guess. There is no fallback group (FR-041). */
  group?: string;
  version?: string;
  /** Opt in to concurrent execution alongside adjacent parallel-safe calls in
   *  the same turn (see `AssistantTool.parallelSafe` and agent-loop.ts's
   *  batching). Absent/false = strictly sequential, which is how every service
   *  tool behaved before this existed, so declaring nothing stays correct.
   *
   *  A service should only set this on a tool that is safe alongside a COPY OF
   *  ITSELF and alongside its neighbours — in practice, read-only operations.
   *  The worker already correlates concurrent invocations by callId, so the IPC
   *  layer imposes no obstacle; the constraint is entirely about what the
   *  handler touches. Never set it on a writer: two concurrent upserts to the
   *  same record, or any lazily-created shared resource, will corrupt state. */
  parallelSafe?: boolean;
}

/** A `ToolDeclaration` plus the service that owns it and how BOS reaches it.
 *  v1 (ADR-001/ADR-004) supports worker IPC only; `transport` is reserved so a
 *  future backend can extend it without changing the `AssistantTool` surface. */
export interface ServiceTool {
  declaration: ToolDeclaration;
  serviceId: string;
  transport: "worker-ipc";
  /** The resolved tool-group id this tool was registered under (041). Kept on
   *  the record so unregistration can drop a group once its last member goes. */
  groupId: string;
}

/** A request to invoke a service-declared tool, sent Main→Worker as the
 *  payload of a `tool_call` message. */
export interface ToolInvocation {
  callId: string;
  name: string;
  args: unknown;
}

/** The result of a `ToolInvocation`, sent Worker→Main as the payload of a
 *  `tool_result`/`tool_error` message. Exactly one of `result`/`error` is set. */
export interface ToolInvocationResult {
  callId: string;
  result?: unknown;
  error?: {
    code: string;
    message: string;
    stack?: string;
  };
}

/** Opt-in flag on a service manifest (ADR-002): `"tools"` enables tool
 *  exposure via `tool_declare`; absent or `"default"` keeps the pre-existing
 *  no-tool behavior (backward compatible). */
export type DeploymentMode = "default" | "tools";
