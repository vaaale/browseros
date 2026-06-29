// The main-chat actions shown in the Assistant's right side panel. Derived from
// the single capability registry (016-unified-agents) so it never drifts from the
// actions actually registered / gated.

import { actionCapabilities } from "./capabilities-registry";

export interface ToolInfo {
  group: string;
  name: string;
  description: string;
}

export const ASSISTANT_TOOLS: ToolInfo[] = actionCapabilities().map((c) => ({
  group: c.group,
  name: c.id,
  description: c.description,
}));
