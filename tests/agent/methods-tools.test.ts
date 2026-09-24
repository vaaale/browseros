// `workflow_list` belongs to the Workflows app, not to the method layer.
//
// THE COLLISION: the Workflows marketplace item declares a service tool named
// `workflow_list` (services/service.json's own description lists it), and BOS's
// method layer defined a built-in of the same name. registry.ts resolves that
// deterministically — "built-ins below always win a name collision" — so the
// app's tool was silently dropped, while its docs, its tool-group description
// and its skill all went on naming it.
//
// The method-layer tool is now `methods_list`, which is what it always listed:
// installed method packs, their phases, and each one's driver skill.
//
// WHY THIS TEST IS GREP-SHAPED
//
// The rename's failure mode is SILENT and worse than a crash. A leftover
// `workflow_list` in a seeded agent or driver skill does not error — it now
// resolves to the Workflows app's tool, so an agent asking "what methods exist"
// gets a list of automation workflows and no indication anything was redirected.
// Nothing at runtime can tell those two apart, so the guard has to be over the
// text that names them.
//
//   npm run test:unit -- tests/agent/methods-tools.test.ts
import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { execFileSync } from "child_process";
import { readFileSync } from "fs";

test("no BOS-owned file routes method work at `workflow_list`", () => {
  const files = execFileSync("git", ["ls-files", "src", "seed", "docs"], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);

  // A mention is allowed ONLY where it is disambiguating — the tool description
  // that tells an agent the two are different things has to name both. Anything
  // else (a tools: allowlist entry, a driver instruction) routes method work at
  // the Workflows app, which is the failure this rename exists to prevent, and
  // it fails silently because that tool really does exist.
  const allowed = (lineText: string) => lineText.includes("Workflows app");

  // The WHOLE family moved, not just the listing tool — `workflow_*` is the
  // Workflows app's namespace now, with no overlap left in either direction.
  const METHOD_TOOLS = [
    "workflow_list",
    "workflow_fork_status",
    "workflow_fork",
    "workflow_edit",
    "workflow_phase_instructions_set",
    "workflow_phase_instructions",
  ];

  const stale: string[] = [];
  for (const f of files) {
    let body = "";
    try {
      body = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    body.split("\n").forEach((lineText, i) => {
      for (const t of METHOD_TOOLS) {
        if (lineText.includes(t) && !allowed(lineText)) {
          stale.push(`${f}:${i + 1}  ${t}`);
          break;
        }
      }
    });
  }

  expect(
    stale,
    "these route method work at a tool the method layer no longer defines; the call now silently reaches " +
      "the Workflows app instead of erroring:\n  " + stale.join("\n  "),
  ).toEqual([]);
});

test("the method tool is registered as `methods_list`", async () => {
  const src = readFileSync("src/lib/assistant/tools/server/specs.ts", "utf8");
  expect(src, "the server tool is declared under its new id").toContain('"methods_list"');
  expect(src, "and the registry key matches the declared name").toContain("methods_list:");
});

test("the drivers that tell an agent to call it were updated too", () => {
  // These are the files that ROUTE an agent to the method layer. A driver still
  // saying `workflow_list` sends it to the Workflows app, which is precisely the
  // confusion this rename exists to remove.
  for (const f of [
    "seed/agents/build-studio/AGENT.md",
    "seed/method-packs/spec-kit/skills/spec-kit-driver/SKILL.md",
  ]) {
    const body = readFileSync(f, "utf8");
    expect(body, `${f} must name the method tool`).toContain("methods_list");
  }
});

test("the guard scans the files that matter", () => {
  // Without this, the scan above passes vacuously if `git ls-files` ever stops
  // reaching seed/ — and a driver could go back to naming the app's tool unseen.
  const scanned = execFileSync("git", ["ls-files", "src", "seed", "docs"], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  for (const f of [
    "src/lib/assistant/tools/server/specs.ts",
    "seed/agents/build-studio/AGENT.md",
    "seed/method-packs/spec-kit/skills/spec-kit-driver/SKILL.md",
  ]) {
    expect(scanned, `${f} is inside the scanned corpus`).toContain(f);
  }
});

test("every method tool is registered, in the `methods` group", async () => {
  // Registration is what makes a tool DISCOVERABLE: find_tools searches this
  // registry (discovery.ts), so an unregistered tool cannot be found by search
  // at all — only handed to an agent by name in its allowlist. All six were
  // missing, which is why two find_tools queries aimed at the method layer came
  // back empty while the tool sat there working.
  const { listCapabilities } = await import("../../src/lib/agent/capabilities-registry");
  const { groupById } = await import("../../src/lib/agent/tool-groups");

  const expected = [
    "methods_list",
    "methods_fork",
    "methods_fork_status",
    "methods_edit",
    "methods_phase_instructions",
    "methods_phase_instructions_set",
  ];
  const caps = new Map(listCapabilities().map((c) => [c.id, c]));
  for (const id of expected) {
    const cap = caps.get(id);
    expect(cap, `${id} has no capability entry — it would be invisible to find_tools`).toBeTruthy();
    expect(cap!.group, `${id} belongs to the methods group`).toBe("methods");
  }
  expect(groupById("methods")?.name, "and that group actually exists").toBe("Methods");
});

test("the method tools and the Workflows app no longer share a single name", async () => {
  // The whole point. The app declares workflow_list/create/read/modify/run/
  // status/cancel/delete/export/validate/run_list/run_get/run_delete/event_types;
  // ours are all methods_*. One collision used to exist and it was silent.
  const { listCapabilities } = await import("../../src/lib/agent/capabilities-registry");
  const ours = listCapabilities().filter((c) => c.group === "methods").map((c) => c.id);
  expect(ours.length, "the methods group is populated").toBeGreaterThan(0);
  expect(
    ours.filter((id) => id.startsWith("workflow_")),
    "no method tool may sit in the Workflows app's namespace",
  ).toEqual([]);
});
