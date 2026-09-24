// THE GUARD THAT WAS MISSING TWICE.
//
// A server tool that has no entry in the capabilities registry is INVISIBLE:
// `find_tools` searches `listCapabilities()`, so a tool absent from it cannot be
// discovered by an agent that does not already know its name, and cannot be put
// in a tool group. Nothing errors — the tool exists, is callable, and is never
// found.
//
// It has now happened twice. First the six method tools (`methods_*`), which
// shipped ungrouped and undiscoverable. Then `methods_project_runtime`, which
// installs BMAD's `_bmad/` scripts into the user's repository: absent from the
// registry AND from every seeded agent's allowlist, so no agent could call it,
// and BMAD's skills — 75 of which shell out to those scripts — had no way to
// get them. The live symptom was an agent explaining that it would "honour the
// intent" of a step it could not perform.
//
// Both were invisible in exactly the same way, so the rule is asserted rather
// than remembered.
//
//   npm run test:unit -- tests/agent/tool-capability-coverage.test.ts
import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import { CAPABILITIES } from "../../src/lib/agent/capabilities-registry";
import { listToolGroups } from "../../src/lib/agent/tool-groups";

/** Tool names as the registry declares them — `serverTool("name", …)`. Read
 *  from source rather than by
 *  building the live registry, which needs a request context and would drag in
 *  every service tool the deployment happens to have installed. */
function declaredServerTools(): string[] {
  const files = execFileSync("git", ["ls-files", "src/lib/assistant/tools/server"], { encoding: "utf8" })
    .split("\n")
    .filter((f) => f.endsWith(".ts"));
  const names = new Set<string>();
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/serverTool\(\s*\n?\s*"([a-z0-9_]+)"/g)) names.add(m[1]);
  }
  return [...names].sort();
}

/** Server tools with no capability entry TODAY. They are undiscoverable —
 *  `find_tools` cannot return them and they belong to no group — so this list is
 *  a defect inventory, not a permitted set. The test's job is that it only ever
 *  SHRINKS: a new tool may not join it.
 *
 *  Not fixed here because each entry needs a group and a description written by
 *  someone who knows what the tool is for, and a wrong description is worse than
 *  none — it is what made `find_tools` answer "order me a pizza" with three
 *  method tools. */
const KNOWN_UNDISCOVERABLE = [
  "a2ui_render",
  "ack_event",
  "create_project",
  "delete_project",
  "emit_event",
  "find_agent",
  "find_tools",
  "get_event",
  "git_add_remote",
  "git_fetch",
  "git_list_branches",
  "git_list_mounts",
  "git_list_remotes",
  "git_merge",
  "git_mount",
  "git_push",
  "git_push_all_remotes",
  "git_remove_remote",
  "git_sync",
  "git_unmount",
  "list_event_handlers",
  "mark_events_read",
  "query_events",
  "rename_project",
  "set_event_preference",
  "skill_patch",
].sort();

test("no NEW server tool ships without a capability entry", () => {
  const known = new Set(CAPABILITIES.map((c) => c.id));
  const missing = declaredServerTools().filter((t) => !known.has(t));
  expect(
    missing,
    "a tool with no capability entry cannot be discovered by any agent — add one to capabilities-registry.ts " +
      "(and if you FIXED one of the known gaps, delete it from KNOWN_UNDISCOVERABLE)",
  ).toEqual(KNOWN_UNDISCOVERABLE);
});

test("every capability names a group that exists", () => {
  // FR-041: there is no fallback group. A capability pointing at a group that
  // does not exist is the same invisibility by another route.
  const groups = new Set(listToolGroups().map((g) => g.id));
  const orphans = CAPABILITIES.filter((c) => c.context !== "action" && !groups.has(c.group)).map(
    (c) => `${c.id} -> ${c.group}`,
  );
  expect(orphans, "unknown group id").toEqual([]);
});

// NOT ASSERTED HERE: that a seeded agent's allowlist names only real tools.
// An allowlist legitimately names SERVICE tools (`bot_*`, an item's own), which
// exist only when that item is installed — so a static check flags 470 names
// that are fine. Validating it needs a live registry with a known set of
// installed items, which is an e2e concern, not this file's.
