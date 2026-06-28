export interface McpServerConfig {
  /** Unique identifier and friendly name — the key servers are stored/looked up by. */
  name: string;
  /** What the server is for, shown to the agent as an index so it can decide which
   *  server to drill into (014-mcp-tool-gateway). Empty → a default is derived. */
  description?: string;
  /** Transport to use. Defaults to streamable HTTP. */
  transport?: "http" | "sse" | "stdio";
  /** http/sse: the server URL. (stdio ignores this when `command` is set; kept as a
   *  command-line fallback for older stdio configs.) */
  endpoint?: string;
  /** http/sse: convenience bearer token — sent as `Authorization: Bearer <apiKey>`. */
  apiKey?: string;
  /** http/sse: extra request headers (e.g. { "Private-Token": "…" }). Merged with — and
   *  overriding — the apiKey Authorization header. */
  headers?: Record<string, string>;
  /** stdio: the executable to spawn (e.g. "docker", "npx", "claude"). */
  command?: string;
  /** stdio: arguments passed to `command`. */
  args?: string[];
  /** stdio: working directory for the spawned process (defaults to the repo root). */
  cwd?: string;
  /** stdio: extra environment variables for the spawned process. */
  env?: Record<string, string>;
}

export interface McpProbeResult {
  ok: boolean;
  tools?: string[];
  error?: string;
}

// One MCP tool as surfaced to the agent by the gateway (014-mcp-tool-gateway):
// enough to choose and call it (name + description + input JSON schema), tagged
// with its server so calls are unambiguous.
export interface McpToolDescriptor {
  server: string;
  name: string;
  description?: string;
  schema?: unknown;
}
