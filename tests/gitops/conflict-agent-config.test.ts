// 035-spec-promote-conflict-escalation — the configurable conflict agent
// (FR-025 / T031) and the tool wiring that makes it able to act at all.
//
// The failure mode this guards is quiet and total: if `conflict_*` isn't in
// the capability registry, `gate.ts` never offers those tools to ANY agent, so
// every escalation looks like it started and then did nothing.
//
//   npm run test:unit -- tests/gitops/conflict-agent-config.test.ts
import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { join } from "path";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";

const CONFLICT_TOOL_IDS = [
  "conflict_read",
  "conflict_write",
  "conflict_decision",
  "conflict_status",
  "conflict_complete",
  "conflict_abandon",
];

function useTempDataDir(): { data: string; cleanup: () => void } {
  const data = mkdtempSync(join(tmpdir(), "conflict-cfg-"));
  // RESTORE the previous value on cleanup. Playwright runs several test FILES
  // in one worker process, so leaving BOS_DATA_DIR pointing at a directory
  // this test then deletes would break every later test in that worker.
  const previous = process.env.BOS_DATA_DIR;
  process.env.BOS_DATA_DIR = data;
  return {
    data,
    cleanup: () => {
      if (previous === undefined) delete process.env.BOS_DATA_DIR;
      else process.env.BOS_DATA_DIR = previous;
      rmSync(data, { recursive: true, force: true });
    },
  };
}

test("build-studio.conflictAgent defaults to devops and reflects a saved value (FR-025)", async () => {
  const data = useTempDataDir();
  try {
    const { getConfigValue } = await import("../../src/lib/config/registry");
    expect(await getConfigValue("build-studio", "conflictAgent")).toBe("devops");

    // Read on EVERY escalation, so a change takes effect with no reload — this
    // asserts the value genuinely round-trips through the config store.
    const { patchNamespace } = await import("../../src/lib/config/store");
    await patchNamespace("build-studio", { conflictAgent: "my-resolver" });
    expect(await getConfigValue("build-studio", "conflictAgent")).toBe("my-resolver");

    // The BS chat agent field is untouched by the new one.
    expect(await getConfigValue("build-studio", "agent")).toBe("build-studio");
  } finally {
    data.cleanup();
  }
});

test("reconcile reads the configured agent at escalation time, defaulting to devops (FR-023/FR-025)", () => {
  const src = readFileSync(join(__dirname, "..", "..", "src/lib/gitops/reconcile.ts"), "utf8");
  // The hard-coded constant is no longer what the escalation uses...
  expect(src).toContain('getConfigValue("build-studio", "conflictAgent")');
  expect(src).toContain("const agentId = await conflictAgentId()");
  // ...but it IS still the default, which is what keeps the pre-existing
  // source-repo escalation byte-identical (FR-023).
  expect(src).toContain('const DEVOPS_AGENT_ID = "devops"');
  expect(src).toMatch(/configured\.trim\(\)\s*:\s*DEVOPS_AGENT_ID/);
  // And the conversation is created with the resolved agent, not the constant.
  expect(src).toContain("createDevOpsConversation(\n      agentId,");
});

test("all six conflict tools are registered and gateable", async () => {
  const { CAPABILITIES } = await import("../../src/lib/agent/capabilities-registry");
  const ids = new Set(CAPABILITIES.map((c) => c.id));
  for (const id of CONFLICT_TOOL_IDS) {
    // gate.ts builds its registry from listCapabilities(); an id missing here
    // is silently dropped from every agent's allowlist.
    expect(ids.has(id), `${id} is missing from the capability registry`).toBe(true);
  }

  const { conflictResolveTools } = await import("../../src/lib/assistant/tools/server/conflict-resolve");
  const tools = conflictResolveTools();
  expect(Object.keys(tools).sort()).toEqual([...CONFLICT_TOOL_IDS].sort());
  for (const id of CONFLICT_TOOL_IDS) {
    expect(tools[id].execution).toBe("server");
  }

  const registry = readFileSync(join(__dirname, "..", "..", "src/lib/assistant/registry.ts"), "utf8");
  expect(registry).toContain("...conflictResolveTools(),");
});

test("the seeded devops agent has the conflict tools in its allowlist", () => {
  const seed = readFileSync(join(__dirname, "..", "..", "seed/agents/devops/AGENT.md"), "utf8");
  for (const id of CONFLICT_TOOL_IDS) {
    expect(seed, `${id} missing from the devops seed`).toContain(id);
  }
});

test("an upgraded install's pre-existing devops agent is backfilled with the conflict tools", async () => {
  const data = useTempDataDir();
  try {
    // Recreate the R-upgrade hazard exactly: `applySeedAgent` returns early
    // when data/agents/devops/AGENT.md already exists, so a pre-035 install
    // would keep an allowlist with no conflict_* ids at all — and every
    // escalation would fail at the first tool call.
    const dir = join(data.data, "agents", "devops");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "AGENT.md"),
      [
        "---",
        "name: DevOps",
        "description: legacy",
        "type: local",
        "tools: [dev_delegate, dev_git_status]",
        "useDefaultPrompt: false",
        "---",
        "",
        "Legacy body the user may have edited.",
      ].join("\n"),
    );

    const { getAgent } = await import("../../src/lib/agent/subagents/store");
    const agent = await getAgent("devops");
    expect(agent).toBeTruthy();
    for (const id of CONFLICT_TOOL_IDS) {
      expect(agent!.tools, `${id} was not backfilled`).toContain(id);
    }
    // Additive: the agent's pre-existing tools and its edited prompt survive.
    expect(agent!.tools).toContain("dev_delegate");
    expect(agent!.systemPrompt).toContain("Legacy body the user may have edited.");
  } finally {
    data.cleanup();
  }
});
