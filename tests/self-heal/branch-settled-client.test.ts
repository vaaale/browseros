import { test, expect } from "@playwright/test";
import { notifySelfHealBranchSettled } from "../../src/lib/self-heal/branch-settled-client";

// 031-self-healing FR-038(a) — the client-side fire-and-forget notice the
// version controls send after a promote/discard. Contract under test: it posts
// the branch + outcome to op=branch-settled with keepalive (both callers reload
// the page right after), does nothing for an empty branch, and NEVER throws —
// a lost notice is fine by design (the boot reconcile is the guarantee), so a
// failed fetch is at most a console.warn.

type FetchArgs = { input: string; init: RequestInit };

function stubFetch(impl: () => Promise<unknown>): { calls: FetchArgs[]; restore: () => void } {
  const calls: FetchArgs[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    calls.push({ input: String(input), init: init ?? {} });
    return impl();
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

test("posts the branch and outcome to op=branch-settled, with keepalive", async () => {
  const { calls, restore } = stubFetch(async () => new Response("{}"));
  try {
    notifySelfHealBranchSettled("bos/self-heal-0001", "promoted");
    expect(calls).toHaveLength(1);
    expect(calls[0].input).toBe("/api/self-heal?op=branch-settled");
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.keepalive).toBe(true);
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ branch: "bos/self-heal-0001", outcome: "promoted" });
  } finally {
    restore();
  }
});

test("an empty branch is a no-op — nothing is fetched", async () => {
  const { calls, restore } = stubFetch(async () => new Response("{}"));
  try {
    notifySelfHealBranchSettled("", "discarded");
    expect(calls).toEqual([]);
  } finally {
    restore();
  }
});

test("a failed fetch never throws — best-effort means a warning at most", async () => {
  const { restore } = stubFetch(async () => {
    throw new Error("network down");
  });
  const warnings: unknown[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(args);
  try {
    expect(() => notifySelfHealBranchSettled("bos/self-heal-0002", "discarded")).not.toThrow();
    // The rejection is handled asynchronously — settle the microtask queue.
    await new Promise((r) => setTimeout(r, 0));
    expect(warnings.length).toBe(1);
    expect(String(warnings[0])).toContain("bos/self-heal-0002");
  } finally {
    console.warn = originalWarn;
    restore();
  }
});
