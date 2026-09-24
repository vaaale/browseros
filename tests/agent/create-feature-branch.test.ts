// Creating a feature branch and making it active — the pair, in one place.
//
// There are now two ways to start one: the assistant's branch selector, and
// Build Studio's tree, where an edit to a repository ELICITS a branch rather
// than refusing without one. Build Studio used to grey those actions out
// instead, which was correct about the requirement and a dead end in a
// registered repository: its branch is created for it when the Supervisor mounts
// the repo, so the only thing a user can supply is the NAME — and before this
// there was nowhere in the product to supply it for a non-BOS repo.
//
//   npm run test:unit -- tests/agent/create-feature-branch.test.ts
import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { createAndActivateFeatureBranch } from "../../src/lib/agent/create-feature-branch";

type Call = { url: string; body: unknown };

/** Stub `fetch` for one call, capturing what was sent. */
function stubFetch(response: unknown, status = 200): { calls: Call[]; restore: () => void } {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return { ok: status < 400, status, json: async () => response } as Response;
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test("the name is sent to the server, and the branch it returns is the one used", async () => {
  // The SERVER normalizes (`My Change` -> `bos/testfixture-my-change`), so the caller must
  // use what came back rather than what it sent. A caller that assumed its own
  // input would write specs on a branch name that does not exist.
  const f = stubFetch({ ok: true, branch: "bos/testfixture-my-change" });
  try {
    const { branch } = await createAndActivateFeatureBranch("My Change");
    expect(branch).toBe("bos/testfixture-my-change");
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].url).toContain("/api/assistant/feature-branches");
    expect(f.calls[0].body).toEqual({ name: "My Change" });
  } finally {
    f.restore();
  }
});

test("a refusal throws with the SERVER's message, which names what was wrong", async () => {
  // The server's message says why the name was unusable. Replacing it with a
  // generic failure leaves the user retyping the same invalid name.
  const f = stubFetch({ ok: false, error: 'Invalid branch name "": use a lowercase kebab name like "my-change" (1-4 words).' }, 400);
  try {
    await expect(createAndActivateFeatureBranch("")).rejects.toThrow(/lowercase kebab name/);
  } finally {
    f.restore();
  }
});

test("with no conversation to record it on, the branch is still returned", async () => {
  // Build Studio's tree can act before its chat pane has a conversation.
  // Refusing there would reintroduce the dead end this function removes — the
  // caller still needs the branch for the write it is about to make.
  const f = stubFetch({ ok: true, branch: "bos/testfixture-no-conv" });
  try {
    await expect(createAndActivateFeatureBranch("no conv", undefined)).resolves.toEqual({ branch: "bos/testfixture-no-conv" });
  } finally {
    f.restore();
  }
});

test("a malformed success is treated as a failure, not as a branch named undefined", async () => {
  const f = stubFetch({ ok: true });
  try {
    await expect(createAndActivateFeatureBranch("x")).rejects.toThrow(/Could not create/);
  } finally {
    f.restore();
  }
});
