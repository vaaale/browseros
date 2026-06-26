import "server-only";
import { getConfigValue } from "@/lib/config/registry";

// The dev-harness endpoint (configurable in Settings → Dev Harness). The agent
// type is NOT configured here — it is generated per sub-agent (see claude-runner).
export async function getHarnessConfig(): Promise<{ url: string }> {
  const url = ((await getConfigValue("dev-harness", "url")) as string) || "http://wingman.akhbar.home:7272/mcp";
  return { url };
}
