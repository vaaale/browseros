export interface McpServerConfig {
  name: string;
  /** For http/sse: the server URL. For stdio: the command line to spawn (e.g. "claude mcp serve"). */
  endpoint: string;
  apiKey?: string;
  /** Transport to use. Defaults to streamable HTTP. */
  transport?: "http" | "sse" | "stdio";
  /** stdio only: working directory for the spawned process (defaults to the repo root). */
  cwd?: string;
  /** stdio only: extra environment variables for the spawned process. */
  env?: Record<string, string>;
}

export interface McpProbeResult {
  ok: boolean;
  tools?: string[];
  error?: string;
}
