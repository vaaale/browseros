// The built-in default assistant agent id. It is seeded on every install and is
// undeletable, and it's the agent a blank/bootstrap conversation starts with
// (and the agent-picker's initial selection when nothing else is chosen).
//
// This is NOT a runtime resolution fallback: composing instructions / resolving
// an agent for a request REQUIRES an explicit agent id and throws if it's
// missing. This constant only names the built-in agent for protection and for
// seeding brand-new conversations at the UI layer.
//
// Framework-free (no "server-only", no React) so both server and client import it.
export const DEFAULT_AGENT_ID = "assistant";
