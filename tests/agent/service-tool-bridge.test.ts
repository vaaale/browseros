// ServiceToolBridge: register/unregister/collision/schema-validation + the
// invoke() dispatch path — real Ajv validation, a fake in-memory dispatcher
// (no real worker_threads needed here; that's covered end-to-end by
// tests/services/tool-integration.test.ts). Also asserts the structured
// services.tool-bridge logging (T004/T017) fires at the right events.
//   npx playwright test -c playwright.unit.config.ts tests/agent/service-tool-bridge.test.ts
import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { logger } from "../../src/lib/logging";
import { ServiceToolBridge } from "../../src/lib/agent/service-tool-bridge";
import { listCapabilities, unregisterCapabilities } from "../../src/lib/agent/capabilities-registry";
import { unregisterToolGroups } from "../../src/lib/agent/tool-groups";
import type { ToolInvocation, ToolInvocationResult } from "../../src/core/service/serviceToolTypes";

// Every declaration() name used anywhere in this file, so a single afterEach
// can always leave the shared (globalThis) dynamic-capabilities registry clean
// regardless of which test ran — tests in this file share a Playwright worker
// process with every other unit-test file, so an un-cleaned dynamic capability
// id would otherwise leak into unrelated tests (same convention as gate.test.ts
// / tool-gate.test.ts's per-test try/finally).
const ALL_TEST_TOOL_NAMES = ["echo_tool", "tool_one", "tool_two", "tool_three"];
test.afterEach(() => {
  unregisterCapabilities(ALL_TEST_TOOL_NAMES);
  unregisterToolGroups(["test-tools"]);
});

// 041-tool-groups: registerTool now takes the owning service's manifest-declared
// groups. A tool resolving to none of them is rejected outright — there is no
// fallback group any more (FR-041), which is why every call here supplies one.
const GROUPS = [
  { id: "test-tools", name: "Test Tools", description: "Tools declared by the fixture service in these tests." },
];

function declaration(name = "echo_tool") {
  return {
    name,
    description: "Echoes the given text back",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  };
}

/** Captures every logger() call made during `fn()` without touching the real
 *  sink (no BOS_DATA_DIR / log files needed for these pure-logic tests). */
async function captureLogs<T>(fn: () => Promise<T> | T): Promise<{ result: T; records: { level: string; component: string; msg: string; data?: unknown }[] }> {
  const records: { level: string; component: string; msg: string; data?: unknown }[] = [];
  const svc = logger();
  const originalLog = svc.log.bind(svc);
  svc.log = (input) => {
    records.push({ level: input.level, component: input.component, msg: input.msg, data: input.data });
  };
  try {
    const result = await fn();
    return { result, records };
  } finally {
    svc.log = originalLog;
  }
}

test.describe("registerTool", () => {
  test("adds a valid declaration to the registry and logs tool:registered", async () => {
    const bridge = new ServiceToolBridge();
    const { result, records } = await captureLogs(() => bridge.registerTool("svc-a", declaration(), GROUPS));

    expect(result).toBe(true);
    expect(bridge.registry.get("svc-a:echo_tool")?.declaration.name).toBe("echo_tool");
    expect(records).toContainEqual(
      expect.objectContaining({ level: "info", component: "services.tool-bridge", msg: "tool:registered" }),
    );
  });

  test("rejects a duplicate serviceId:name and logs a warning instead of overwriting", async () => {
    const bridge = new ServiceToolBridge();
    bridge.registerTool("svc-a", declaration(), GROUPS);
    const { result, records } = await captureLogs(() => bridge.registerTool("svc-a", { ...declaration(), description: "a different description" }, GROUPS));

    expect(result).toBe(false);
    // The FIRST registration's declaration is untouched.
    expect(bridge.registry.get("svc-a:echo_tool")?.declaration.description).toBe("Echoes the given text back");
    expect(records).toContainEqual(expect.objectContaining({ level: "warn", msg: "tool:register-rejected" }));
  });

  test("rejects a malformed inputSchema without registering", async () => {
    const bridge = new ServiceToolBridge();
    const bad = { ...declaration(), inputSchema: { type: "not-a-real-json-schema-type" } };
    const { result } = await captureLogs(() => bridge.registerTool("svc-a", bad, GROUPS));

    expect(result).toBe(false);
    expect(bridge.registry.has("svc-a:echo_tool")).toBe(false);
  });

  test("two different services can each register a tool of the same name", () => {
    const bridge = new ServiceToolBridge();
    expect(bridge.registerTool("svc-a", declaration(), GROUPS)).toBe(true);
    expect(bridge.registerTool("svc-b", declaration(), GROUPS)).toBe(true);
    expect(bridge.serviceToolsFor("svc-a")).toHaveLength(1);
    expect(bridge.serviceToolsFor("svc-b")).toHaveLength(1);
  });
});

test.describe("unregisterTool / unregisterServiceTools", () => {
  test("unregisterTool removes exactly the named tool", () => {
    const bridge = new ServiceToolBridge();
    bridge.registerTool("svc-a", declaration("tool_one"), GROUPS);
    bridge.registerTool("svc-a", declaration("tool_two"), GROUPS);

    bridge.unregisterTool("svc-a", "tool_one");

    expect(bridge.registry.has("svc-a:tool_one")).toBe(false);
    expect(bridge.registry.has("svc-a:tool_two")).toBe(true);
  });

  test("unregisterServiceTools removes every tool owned by that service only", () => {
    const bridge = new ServiceToolBridge();
    bridge.registerTool("svc-a", declaration("tool_one"), GROUPS);
    bridge.registerTool("svc-a", declaration("tool_two"), GROUPS);
    bridge.registerTool("svc-b", declaration("tool_three"), GROUPS);

    bridge.unregisterServiceTools("svc-a");

    expect(bridge.serviceToolsFor("svc-a")).toHaveLength(0);
    expect(bridge.serviceToolsFor("svc-b")).toHaveLength(1);
  });

  test("a subsequent invoke() on an unregistered tool fails without a tool_call", async () => {
    const bridge = new ServiceToolBridge();
    let dispatched = false;
    bridge.setDispatcher(async (_serviceId, invocation) => {
      dispatched = true;
      return { callId: invocation.callId, result: "ok" };
    });
    bridge.registerTool("svc-a", declaration(), GROUPS);
    bridge.unregisterTool("svc-a", "echo_tool");

    await expect(bridge.invoke("svc-a", "echo_tool", { text: "hi" })).rejects.toThrow(/unknown tool/);
    expect(dispatched).toBe(false);
  });
});

test.describe("capability registration (FR-005 wiring)", () => {
  // gate.ts / tool-gate.ts build their `registryIds` from
  // listCapabilities().map(c => c.id) and gate a tool by comparing that set
  // against the tool's model-facing NAME. If registerTool() only stored the
  // declaration and never told the capability registry, a real service tool
  // would never appear in registryIds and tool-gate.ts's
  // `!registryIds.has(name) => always allow` branch would auto-execute it
  // regardless of allowlist/deferred settings — silently breaking FR-005 for
  // every real service tool despite gate.test.ts/tool-gate.test.ts passing
  // (those tests register the capability by hand, bypassing the bridge).
  test("registerTool adds a capability descriptor whose id equals the tool name", () => {
    const bridge = new ServiceToolBridge();
    bridge.registerTool("svc-a", declaration(), GROUPS);

    const cap = listCapabilities().find((c) => c.id === "echo_tool");
    expect(cap).toBeTruthy();
    // 041-tool-groups: filed under the service's own declared group, not the
    // old catch-all "Service Tools" bucket.
    expect(cap?.group).toBe("test-tools");
    expect(cap?.context).toBe("tool");
    expect(cap?.description).toBe("Echoes the given text back");
  });

  test("unregisterTool removes the capability descriptor", () => {
    const bridge = new ServiceToolBridge();
    bridge.registerTool("svc-a", declaration(), GROUPS);
    bridge.unregisterTool("svc-a", "echo_tool");

    expect(listCapabilities().some((c) => c.id === "echo_tool")).toBe(false);
  });

  test("unregisterServiceTools removes every capability descriptor it owned", () => {
    const bridge = new ServiceToolBridge();
    bridge.registerTool("svc-a", declaration("tool_one"), GROUPS);
    bridge.registerTool("svc-a", declaration("tool_two"), GROUPS);

    bridge.unregisterServiceTools("svc-a");

    expect(listCapabilities().some((c) => c.id === "tool_one")).toBe(false);
    expect(listCapabilities().some((c) => c.id === "tool_two")).toBe(false);
  });

  test("a same-named tool from a DIFFERENT service keeps the capability alive after one owner unregisters", () => {
    const bridge = new ServiceToolBridge();
    bridge.registerTool("svc-a", declaration(), GROUPS);
    bridge.registerTool("svc-b", declaration(), GROUPS);

    bridge.unregisterTool("svc-a", "echo_tool");
    // svc-b's echo_tool is still registered — the capability (and therefore
    // svc-b's gating) must not disappear underneath it.
    expect(listCapabilities().some((c) => c.id === "echo_tool")).toBe(true);

    bridge.unregisterTool("svc-b", "echo_tool");
    expect(listCapabilities().some((c) => c.id === "echo_tool")).toBe(false);
  });
});

test.describe("cache re-arm (version)", () => {
  test("version increments on register and unregister so a stale consumer can detect staleness", () => {
    const bridge = new ServiceToolBridge();
    const v0 = bridge.version;
    bridge.registerTool("svc-a", declaration(), GROUPS);
    const v1 = bridge.version;
    expect(v1).toBeGreaterThan(v0);

    bridge.unregisterServiceTools("svc-a");
    expect(bridge.version).toBeGreaterThan(v1);
  });

  test("a tool registered after a consumer's first read is visible on the next read (assistantTools()-style re-arm)", () => {
    const bridge = new ServiceToolBridge();
    // Simulate a cache keyed by bridge.version, exactly like registry.ts's
    // assistantTools() cache.
    let cache: Record<string, unknown> | undefined;
    let cachedVersion = -1;
    const read = () => {
      if (cache && cachedVersion === bridge.version) return cache;
      cache = Object.fromEntries([...bridge.registry.entries()].map(([k, v]) => [k, v.declaration.name]));
      cachedVersion = bridge.version;
      return cache;
    };

    expect(Object.keys(read())).toHaveLength(0);
    bridge.registerTool("svc-a", declaration(), GROUPS);
    expect(Object.keys(read())).toContain("svc-a:echo_tool");
  });
});

test.describe("invoke — schema validation (FR-004)", () => {
  test("valid args pass validation and dispatch a tool_call", async () => {
    const bridge = new ServiceToolBridge();
    bridge.registerTool("svc-a", declaration(), GROUPS);
    let received: ToolInvocation | undefined;
    bridge.setDispatcher(async (_serviceId, invocation) => {
      received = invocation;
      return { callId: invocation.callId, result: `echo:${(invocation.args as { text: string }).text}` };
    });

    const result = await bridge.invoke("svc-a", "echo_tool", { text: "hello" });

    expect(result).toBe("echo:hello");
    expect(received?.name).toBe("echo_tool");
    expect(received?.args).toEqual({ text: "hello" });
  });

  test("invalid args (missing required field) are rejected without dispatching, and log tool_call:schema-rejected", async () => {
    const bridge = new ServiceToolBridge();
    bridge.registerTool("svc-a", declaration(), GROUPS);
    let dispatched = false;
    bridge.setDispatcher(async (_serviceId, invocation) => {
      dispatched = true;
      return { callId: invocation.callId, result: "should never happen" };
    });

    const { records } = await captureLogs(async () => {
      await expect(bridge.invoke("svc-a", "echo_tool", {})).rejects.toThrow();
    });

    expect(dispatched).toBe(false);
    expect(records).toContainEqual(
      expect.objectContaining({ level: "warn", component: "services.tool-bridge", msg: "tool_call:schema-rejected" }),
    );
  });

  test("invalid args (wrong type) are rejected without dispatching", async () => {
    const bridge = new ServiceToolBridge();
    bridge.registerTool("svc-a", declaration(), GROUPS);
    let dispatched = false;
    bridge.setDispatcher(async (_serviceId, invocation) => {
      dispatched = true;
      return { callId: invocation.callId, result: "should never happen" };
    });

    await expect(bridge.invoke("svc-a", "echo_tool", { text: 42 })).rejects.toThrow();
    expect(dispatched).toBe(false);
  });

  test("a tool_error result from the dispatcher surfaces as a rejected invoke(), and logs tool_call:error", async () => {
    const bridge = new ServiceToolBridge();
    bridge.registerTool("svc-a", declaration(), GROUPS);
    bridge.setDispatcher(async (_serviceId, invocation): Promise<ToolInvocationResult> => ({
      callId: invocation.callId,
      error: { code: "boom", message: "the service tool threw" },
    }));

    const { records } = await captureLogs(async () => {
      await expect(bridge.invoke("svc-a", "echo_tool", { text: "hi" })).rejects.toThrow(/the service tool threw/);
    });
    expect(records).toContainEqual(
      expect.objectContaining({ level: "error", component: "services.tool-bridge", msg: "tool_call:error" }),
    );
  });

  test("forwards the caller's signal to the dispatcher (039-service-tool-exposure T033)", async () => {
    const bridge = new ServiceToolBridge();
    bridge.registerTool("svc-a", declaration(), GROUPS);
    let receivedSignal: AbortSignal | undefined;
    bridge.setDispatcher(async (_serviceId, invocation, signal) => {
      receivedSignal = signal;
      return { callId: invocation.callId, result: "ok" };
    });
    const controller = new AbortController();

    await bridge.invoke("svc-a", "echo_tool", { text: "hi" }, controller.signal);

    expect(receivedSignal).toBe(controller.signal);
  });

  test("a dispatcher rejection tagged 'timeout' logs tool_call:timeout (warn), not tool_call:error", async () => {
    const bridge = new ServiceToolBridge();
    bridge.registerTool("svc-a", declaration(), GROUPS);
    bridge.setDispatcher(async () => {
      throw Object.assign(new Error("timed out waiting for tool call"), { code: "timeout" });
    });

    const { records } = await captureLogs(async () => {
      await expect(bridge.invoke("svc-a", "echo_tool", { text: "hi" })).rejects.toThrow(/timed out/);
    });
    expect(records).toContainEqual(
      expect.objectContaining({ level: "warn", component: "services.tool-bridge", msg: "tool_call:timeout" }),
    );
    expect(records).not.toContainEqual(expect.objectContaining({ msg: "tool_call:error" }));
  });

  test("a dispatcher rejection tagged 'cancelled' (run abort) logs tool_call:cancelled (warn), not tool_call:error", async () => {
    const bridge = new ServiceToolBridge();
    bridge.registerTool("svc-a", declaration(), GROUPS);
    bridge.setDispatcher(async () => {
      throw Object.assign(new Error("tool call cancelled (run aborted)"), { code: "cancelled" });
    });

    const { records } = await captureLogs(async () => {
      await expect(bridge.invoke("svc-a", "echo_tool", { text: "hi" })).rejects.toThrow(/cancelled/);
    });
    expect(records).toContainEqual(
      expect.objectContaining({ level: "warn", component: "services.tool-bridge", msg: "tool_call:cancelled" }),
    );
    expect(records).not.toContainEqual(expect.objectContaining({ msg: "tool_call:error" }));
  });

  test("a dispatcher rejection with no code (e.g. worker crash) logs tool_call:error", async () => {
    const bridge = new ServiceToolBridge();
    bridge.registerTool("svc-a", declaration(), GROUPS);
    bridge.setDispatcher(async () => {
      throw new Error(`worker exited before resolving tool call "x"`);
    });

    const { records } = await captureLogs(async () => {
      await expect(bridge.invoke("svc-a", "echo_tool", { text: "hi" })).rejects.toThrow(/worker exited/);
    });
    expect(records).toContainEqual(
      expect.objectContaining({ level: "error", component: "services.tool-bridge", msg: "tool_call:error" }),
    );
  });

  test("invoke() without a wired dispatcher throws (never silently succeeds)", async () => {
    const bridge = new ServiceToolBridge();
    bridge.registerTool("svc-a", declaration(), GROUPS);

    await expect(bridge.invoke("svc-a", "echo_tool", { text: "hi" })).rejects.toThrow(/dispatch is not wired/);
  });
});

test.describe("parallelSafe passthrough (039 → AssistantTool)", () => {
  test("a declaration's parallelSafe survives registration verbatim", async () => {
    const bridge = new ServiceToolBridge();
    bridge.registerTool("svc-a", { ...declaration("read_thing"), parallelSafe: true }, GROUPS);
    bridge.registerTool("svc-a", declaration("write_thing"), GROUPS);

    const stored = [...bridge.registry.values()];
    const read = stored.find((t) => t.declaration.name === "read_thing");
    const write = stored.find((t) => t.declaration.name === "write_thing");

    // The bridge must not strip or invent the flag: a service that declares it
    // gets it, and one that says nothing stays sequential (the safe default).
    expect(read?.declaration.parallelSafe).toBe(true);
    expect(write?.declaration.parallelSafe).toBeUndefined();
  });
});
