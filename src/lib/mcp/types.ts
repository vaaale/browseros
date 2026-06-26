export interface McpServerConfig {
  name: string;
  endpoint: string;
  apiKey?: string;
  /** Transport to use. Defaults to streamable HTTP. */
  transport?: "http" | "sse";
}

export interface McpProbeResult {
  ok: boolean;
  tools?: string[];
  error?: string;
}
