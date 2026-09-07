// The tools shown in the Assistant's right side panel. Derived from the single
// capability registry (016-unified-agents) so it never drifts from the tools
// actually registered / gated.
//
// 041-tool-groups changed two things here:
//  1. `listCapabilities()` replaces `actionCapabilities()`. The latter filters
//     the STATIC `CAPABILITIES` array, so a marketplace item's service-declared
//     tools never appeared in this panel at all — they only exist in the dynamic
//     layer. The panel now shows everything the agent actually has.
//  2. `Capability.group` is a group ID, so the display name is resolved here
//     rather than rendered raw. A capability whose group doesn't resolve is a
//     bug; `groupName` is undefined for it and the panel says so rather than
//     inventing a heading (FR-041).

import { listCapabilities } from "./capabilities-registry";
import { listToolGroups } from "./tool-groups";

export interface ToolInfo {
  /** Group id (slug). */
  group: string;
  /** Resolved display name, or undefined when the id doesn't resolve. */
  groupName: string | undefined;
  name: string;
  description: string;
}

/** Built fresh on each call: the dynamic capability layer changes as services
 *  start and stop, so a module-level constant would go stale. */
export function assistantToolsManifest(): ToolInfo[] {
  const names = new Map(listToolGroups().map((g) => [g.id, g.name]));
  return listCapabilities()
    .filter((c) => c.context !== "tool")
    .map((c) => ({
      group: c.group,
      groupName: names.get(c.group),
      name: c.id,
      description: c.description,
    }));
}
