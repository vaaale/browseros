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

/** A tool a service declares at startup: a name, description, and input
 *  JSON-schema — mirrors the shape the assistant's `AssistantTool` registry
 *  expects (src/lib/assistant/tools.ts), minus the executor. */
export interface ToolDeclaration {
  name: string;
  description: string;
  /** JSON Schema describing the tool's input arguments. */
  inputSchema: Record<string, unknown>;
  categories?: string[];
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
