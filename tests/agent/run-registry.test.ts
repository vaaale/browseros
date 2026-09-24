import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import {
  _resetRunRegistryForTests,
  abortAllChildren,
  abortHeadlessRun,
  hasRun,
  listRuns,
  registerRun,
  unregisterRun,
} from "../../src/lib/agent/subagents/run-registry";

// 031-self-healing scope-add, FR-032 (design ADR-11). The registry is the only
// thing that makes a headless run reachable from outside itself: the local
// runner's AbortController and the CLI runner's child process are both local
// references today, so nothing can stop a run by id.
//
// The load-bearing case is the CASCADE. A self-heal pipeline case's in-flight
// run is the build-studio run; the actual coding happens in a NESTED Developer
// CLI run with its own runId and its own child process, whose tool stream never
// bubbles up to the parent's onEvent. Aborting only the named run would leave
// that child editing the worktree — Stop would be a lie. So aborting any run in
// a family aborts the whole family.

test.describe("headless run registry (FR-032, ADR-11)", () => {
  test.beforeEach(() => _resetRunRegistryForTests());
  test.afterEach(() => _resetRunRegistryForTests());

  test("a registered run is abortable by id, exactly once, and reports truth", () => {
    let aborts = 0;
    registerRun("run-1", { abort: () => aborts++, agentId: "build-studio" });
    expect(hasRun("run-1")).toBe(true);

    expect(abortHeadlessRun("run-1")).toBe(true);
    expect(aborts).toBe(1);

    // Aborting is also DEREGISTERING: a second Stop on the same run finds
    // nothing to kill and says so rather than pretending (R14).
    expect(abortHeadlessRun("run-1")).toBe(false);
    expect(aborts).toBe(1);
    expect(hasRun("run-1")).toBe(false);
  });

  test("an unknown runId is a no-op that returns false", () => {
    expect(abortHeadlessRun("never-started")).toBe(false);
    expect(hasRun("never-started")).toBe(false);
  });

  test("aborting a parent cascades to its children, and grandchildren", () => {
    const calls: string[] = [];
    registerRun("parent", { abort: () => calls.push("parent") });
    registerRun("child", { abort: () => calls.push("child"), parentRunId: "parent" });
    registerRun("grandchild", { abort: () => calls.push("grandchild"), parentRunId: "child" });
    registerRun("stranger", { abort: () => calls.push("stranger") });

    expect(abortHeadlessRun("parent")).toBe(true);
    expect(calls.sort()).toEqual(["child", "grandchild", "parent"]);
    // An unrelated run is untouched and still live.
    expect(hasRun("stranger")).toBe(true);
    expect(hasRun("child")).toBe(false);
    expect(hasRun("grandchild")).toBe(false);
  });

  test("aborting a CHILD also aborts its parent — the run's work is over either way", () => {
    const calls: string[] = [];
    registerRun("bs", { abort: () => calls.push("bs") });
    registerRun("dev", { abort: () => calls.push("dev"), parentRunId: "bs" });

    // Killing the nested Developer leaves the build-studio run waiting on a
    // tool that will never return, so the family goes together.
    expect(abortHeadlessRun("dev")).toBe(true);
    expect(calls.sort()).toEqual(["bs", "dev"]);
  });

  test("abortAllChildren aborts the descendants and leaves the parent running", () => {
    const calls: string[] = [];
    registerRun("p", { abort: () => calls.push("p") });
    registerRun("c1", { abort: () => calls.push("c1"), parentRunId: "p" });
    registerRun("c2", { abort: () => calls.push("c2"), parentRunId: "p" });

    expect(abortAllChildren("p").sort()).toEqual(["c1", "c2"]);
    expect(calls.sort()).toEqual(["c1", "c2"]);
    expect(hasRun("p")).toBe(true);
    expect(abortAllChildren("nobody")).toEqual([]);
  });

  test("a parentRunId cycle cannot wedge the abort walk", () => {
    const calls: string[] = [];
    registerRun("a", { abort: () => calls.push("a"), parentRunId: "b" });
    registerRun("b", { abort: () => calls.push("b"), parentRunId: "a" });

    expect(abortHeadlessRun("a")).toBe(true);
    expect(calls.sort()).toEqual(["a", "b"]);
  });

  test("a throwing abort handler does not stop the rest of the cascade", () => {
    const calls: string[] = [];
    registerRun("root", {
      abort: () => {
        throw new Error("kill failed");
      },
    });
    registerRun("kid", { abort: () => calls.push("kid"), parentRunId: "root" });

    expect(abortHeadlessRun("root")).toBe(true);
    expect(calls).toEqual(["kid"]);
  });

  test("unregisterRun removes the entry so the registry cannot leak", () => {
    registerRun("done", { abort: () => {}, agentId: "a" });
    expect(listRuns()).toHaveLength(1);
    unregisterRun("done");
    expect(listRuns()).toHaveLength(0);
    // Idempotent: the local runner's `finally` and the CLI's `close` handler
    // can both fire for the same run.
    unregisterRun("done");
    expect(abortHeadlessRun("done")).toBe(false);
  });

  test("an empty runId is never registered, and never matches", () => {
    // A runner that somehow has no id must not create an unkillable ghost
    // entry that a later empty lookup would "find".
    registerRun("", { abort: () => {} });
    expect(listRuns()).toHaveLength(0);
    expect(hasRun("")).toBe(false);
    expect(abortHeadlessRun("")).toBe(false);
  });

  test("a parent whose child is already gone still aborts cleanly", () => {
    const calls: string[] = [];
    registerRun("p", { abort: () => calls.push("p") });
    registerRun("c", { abort: () => calls.push("c"), parentRunId: "p" });
    unregisterRun("c");
    expect(abortHeadlessRun("p")).toBe(true);
    expect(calls).toEqual(["p"]);
  });

  test("a child pointing at a parent that never registered is aborted on its own", () => {
    // The delegating run finished (or lives in another process), so only the
    // child is here: aborting it must still work rather than walking off the
    // end of the chain.
    const calls: string[] = [];
    registerRun("orphan", { abort: () => calls.push("orphan"), parentRunId: "long-gone" });
    expect(abortHeadlessRun("orphan")).toBe(true);
    expect(calls).toEqual(["orphan"]);
  });

  test("abortAllChildren survives a throwing child and a cycle among children", () => {
    const calls: string[] = [];
    registerRun("root", { abort: () => calls.push("root") });
    registerRun("bad", {
      abort: () => {
        throw new Error("kill failed");
      },
      parentRunId: "root",
    });
    registerRun("good", { abort: () => calls.push("good"), parentRunId: "bad" });

    expect(abortAllChildren("root").sort()).toEqual(["bad", "good"]);
    expect(calls).toEqual(["good"]);
    expect(hasRun("root")).toBe(true);
  });

  test("the registry initializes itself lazily, and lists a run with no agent id", () => {
    // The map lives on globalThis so a run started in one module instance is
    // abortable from an API route; a fresh process (or an HMR reload that
    // dropped it) must rebuild it on first touch rather than throw.
    delete (globalThis as unknown as Record<string, unknown>).__bosHeadlessRuns;
    expect(hasRun("anything")).toBe(false);
    registerRun("anonymous", { abort: () => {} });
    expect(listRuns()).toEqual([{ runId: "anonymous", startedAt: expect.any(Number) }]);
  });

  test("listRuns exposes what is in flight, with parentage", () => {
    registerRun("p", { abort: () => {}, agentId: "build-studio" });
    registerRun("c", { abort: () => {}, agentId: "developer", parentRunId: "p" });
    const runs = listRuns();
    expect(runs.map((r) => r.runId).sort()).toEqual(["c", "p"]);
    expect(runs.find((r) => r.runId === "c")).toMatchObject({ agentId: "developer", parentRunId: "p" });
    expect(runs.every((r) => typeof r.startedAt === "number")).toBe(true);
  });
});
