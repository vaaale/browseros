export interface SubAgent {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  /** Tool ids this sub-agent may use. Empty means "all default tools". */
  tools?: string[];
}

export interface SubAgentRunResult {
  agent: string;
  task: string;
  output: string;
  steps: number;
  toolCalls: { tool: string; input: unknown }[];
  error?: string;
}
