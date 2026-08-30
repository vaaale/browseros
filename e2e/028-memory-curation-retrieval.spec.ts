import { test, expect, type Page } from "./fixtures";

// 028-memory-curation-retrieval — end-to-end coverage for the five slices:
//   US1 soft budget, US2 agent self-edit, US3 holistic consolidation (flag
//   round-trip), US4 hybrid retrieval + provider embedding endpoint (Settings
//   surface), US5 temporal validity (state/provenance on search results).
//
// Determinism: memory-tool assertions go through the SAME `/api/memory`
// routes the live `memory_save`/`memory_replace`/`memory_remove` tools call
// into (topics.ts), so no live model is required for most of this file. One
// test additionally drives the real assistant tool loop via the scripted e2e
// provider (BOS_E2E_SCRIPTED=1 + `@@e2e {...}`, same mechanism as
// assistant-v2.spec.ts / 039-service-tool-exposure.spec.ts) to prove
// `memory_save` is reachable BY NAME from the live tool registry, not just
// that the underlying topics.ts functions work in isolation.
//
// Dense-signal assertions (SC-003's paraphrase-recall claim) need a
// configured/stubbed embedding endpoint per plan.md's Test Strategy — this
// file exercises the SC-007 degraded path (the actual default in this
// environment: no embeddings.model configured) plus sparse ranking, the
// relevance floor, and provenance/state, which don't need one.

const script = (turns: unknown[]) => `@@e2e ${JSON.stringify({ turns })}`;

async function openAssistantOnFreshConversation(page: Page): Promise<void> {
  // The sandbox's headless desktop can be slow to launch a window after the
  // double-click below, so these timeouts are generous relative to a normal
  // dev environment — widen them here rather than tightening the assertions.
  await page.getByText("Assistant", { exact: true }).first().dblclick({ timeout: 30000 });
  const win = page.getByTestId("assistant-v2");
  await expect(win).toBeVisible({ timeout: 30000 });
  await expect(page.getByTestId("chat-textarea")).toBeVisible({ timeout: 20000 });
  // The Assistant app renders the all-agents conversation panel: every agent
  // with history gets its own "New <Agent> conversation" button, and an
  // un-renamed row is itself titled "New conversation (double-click to
  // rename)". A loose /New .*conversation/i match on the whole window can
  // hit whichever of those sorts first in the DOM — e.g. another agent's
  // create button — leaving AGENT's own active conversation pointed at an
  // old, unrelated chat instead of a fresh one. Target AGENT's own create
  // button by its exact title so this reliably starts a fresh conversation
  // for AGENT ("assistant"), regardless of what else is in the list.
  await win.getByTitle("New Assistant conversation", { exact: true }).click();
  await page.waitForTimeout(400);
}

// The main chat's pinned agent id (src/lib/agent/agent-ids.ts DEFAULT_AGENT_ID).
const AGENT = "assistant";

// ── US1/US2/US3 — soft budget + self-edit + no forced shard ────────────────

test.describe.serial("Memory curation — soft budget + agent self-edit (028)", () => {
  const TOPIC = "e2e-028-tidy-topic";

  test.afterAll(async ({ request }) => {
    await request.delete(`/api/memory?agent=${AGENT}&target=topic&topic=${TOPIC}`).catch(() => {});
  });

  test.beforeAll(async ({ request }) => {
    await request.delete(`/api/memory?agent=${AGENT}&target=topic&topic=${TOPIC}`).catch(() => {});
  });

  test("SC-001: saving over budget succeeds (no hard reject) and both entries persist", async ({ request }) => {
    const r1 = await request.post(`/api/memory?agent=${AGENT}`, {
      data: { target: "topic", action: "add", topic: TOPIC, content: "e2e-028 baseline entry." },
    });
    const b1 = await r1.json();
    expect(r1.ok()).toBe(true);
    expect(b1.success).toBe(true);
    expect(b1.error).toBeUndefined();

    // A single entry big enough to push the topic over its (default 4000
    // char) budget on its own — this is exactly the previously-reported
    // "Over budget … create a shard" failure.
    const huge = "e2e-028 filler content padding the topic past its budget. ".repeat(90); // ~5.4k chars
    const r2 = await request.post(`/api/memory?agent=${AGENT}`, {
      data: { target: "topic", action: "add", topic: TOPIC, content: huge },
    });
    const b2 = await r2.json();
    expect(r2.ok()).toBe(true);
    expect(b2.success).toBe(true);
    expect(b2.error).toBeUndefined();
    expect(String(b2.message ?? "")).not.toMatch(/over budget/i);

    const detail = await (await request.get(`/api/memory?agent=${AGENT}&topic=${TOPIC}`)).json();
    expect(detail.entries).toHaveLength(2);
  });

  test("US2/SC-005: replace + remove tidy the topic, no -2 shard, unknown id errors cleanly", async ({ request }) => {
    const added = await (
      await request.post(`/api/memory?agent=${AGENT}`, {
        data: { target: "topic", action: "add", topic: TOPIC, content: "e2e-028 needs a correction." },
      })
    ).json();
    expect(added.success).toBe(true);
    expect(added.entryId).toBeTruthy();

    const replaced = await (
      await request.post(`/api/memory?agent=${AGENT}`, {
        data: { target: "topic", action: "replace", topic: TOPIC, id: added.entryId, content: "e2e-028 corrected text." },
      })
    ).json();
    expect(replaced.success).toBe(true);

    const afterReplace = await (await request.get(`/api/memory?agent=${AGENT}&topic=${TOPIC}`)).json();
    const texts: string[] = afterReplace.entries.map((e: { text: string }) => e.text);
    expect(texts).toContain("e2e-028 corrected text.");
    expect(texts).not.toContain("e2e-028 needs a correction.");

    const removed = await (
      await request.delete(
        `/api/memory?agent=${AGENT}&target=topic&topic=${TOPIC}&id=${encodeURIComponent(replaced.entryId)}`,
      )
    ).json();
    expect(removed.success).toBe(true);
    const afterRemove = await (await request.get(`/api/memory?agent=${AGENT}&topic=${TOPIC}`)).json();
    expect(afterRemove.entries.map((e: { text: string }) => e.text)).not.toContain("e2e-028 corrected text.");

    // No "-2" shard was ever created to work around the budget/tidy need.
    const shardRes = await request.get(`/api/memory?agent=${AGENT}&topic=${TOPIC}-2`);
    expect(shardRes.status()).toBe(404);

    // Unknown entry id → a clear error, no change (US2 acceptance #3).
    const badReplace = await (
      await request.post(`/api/memory?agent=${AGENT}`, {
        data: { target: "topic", action: "replace", topic: TOPIC, id: "no-such-entry-id", content: "irrelevant" },
      })
    ).json();
    expect(badReplace.success).toBe(false);
    expect(badReplace.error).toBeTruthy();

    const badRemove = await (
      await request.delete(`/api/memory?agent=${AGENT}&target=topic&topic=${TOPIC}&id=no-such-entry-id`)
    ).json();
    expect(badRemove.success).toBe(false);
    expect(badRemove.error).toBeTruthy();
  });

  test("FR-004: replacing an entry to duplicate text dedupes rather than leaving two copies", async ({ request }) => {
    const first = await (
      await request.post(`/api/memory?agent=${AGENT}`, {
        data: { target: "topic", action: "add", topic: TOPIC, content: "e2e-028 entry A." },
      })
    ).json();
    await request.post(`/api/memory?agent=${AGENT}`, {
      data: { target: "topic", action: "add", topic: TOPIC, content: "e2e-028 entry B." },
    });

    const replaced = await (
      await request.post(`/api/memory?agent=${AGENT}`, {
        data: { target: "topic", action: "replace", topic: TOPIC, id: first.entryId, content: "e2e-028 entry B." },
      })
    ).json();
    expect(replaced.success).toBe(true);

    const detail = await (await request.get(`/api/memory?agent=${AGENT}&topic=${TOPIC}`)).json();
    const dupCount = detail.entries.filter((e: { text: string }) => e.text === "e2e-028 entry B.").length;
    expect(dupCount).toBe(1);
  });

  // Proves memory_save is reachable BY NAME from the live assistant tool loop
  // (not just that topics.ts works standalone) — the real registration path
  // exercised by src/lib/assistant/registry.ts → tools/server/memory.ts.
  test("memory_save is wired into the live assistant tool registry", async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto("/");
    await openAssistantOnFreshConversation(page);
    await page.getByTestId("chat-textarea").fill(
      script([
        { text: "saving a note", tools: [{ name: "memory_save", args: { topic: TOPIC, content: "e2e-028 tool-wired note." } }] },
        { text: "Saved it." },
      ]),
    );
    await page.getByTestId("chat-send-button").click();

    await expect(page.getByTestId("tool-card").first()).toBeVisible({ timeout: 30000 });
    await expect(page.getByTestId("assistant-message").last()).toContainText("Saved it.", { timeout: 30000 });

    const convId = await page.evaluate(() => localStorage.getItem("bos.activeConversation.assistant") ?? "");
    const { messages } = await page.request
      .get(`/api/assistant/conversations/${convId}/messages`)
      .then((r) => r.json());
    const toolMessage = (messages as { role: string; content: string }[]).find((m) => m.role === "tool");
    expect(toolMessage?.content).toBeTruthy();
    expect(toolMessage?.content).not.toMatch(/^Error/);

    const detail = await (await page.request.get(`/api/memory?agent=${AGENT}&topic=${TOPIC}`)).json();
    expect(detail.entries.map((e: { text: string }) => e.text)).toContain("e2e-028 tool-wired note.");
  });
});

// ── US4 — hybrid search: sparse ranking, relevance floor, degradation ──────

test.describe.serial("Memory curation — hybrid search + graceful degradation (028)", () => {
  const SEARCH_AGENT = "e2e-028-search-agent";
  const TOPIC = "deploy-notes";

  test.beforeAll(async ({ request }) => {
    await request.post(`/api/memory?agent=${SEARCH_AGENT}`, {
      data: { target: "topic", action: "create", topic: TOPIC, content: "Deployment notes." },
    });
    await request.post(`/api/memory?agent=${SEARCH_AGENT}`, {
      data: { target: "topic", action: "add", topic: TOPIC, content: "Kubernetes is what we use for production deploys." },
    });
    await request.post(`/api/memory?agent=${SEARCH_AGENT}`, {
      data: { target: "topic", action: "add", topic: TOPIC, content: "The cafeteria menu changed to serve tacos on Fridays." },
    });
  });

  test.afterAll(async ({ request }) => {
    await request.delete(`/api/memory?agent=${SEARCH_AGENT}&target=topic&topic=${TOPIC}`).catch(() => {});
  });

  test("SC-007: with embeddings disabled, sparse+recency+importance ranks results with zero errors", async ({ request }) => {
    const res = await request.get(`/api/memory/search?agent=${SEARCH_AGENT}&q=${encodeURIComponent("kubernetes deploy")}`);
    expect(res.ok()).toBe(true);
    const body = await res.json();
    expect(Array.isArray(body.results)).toBe(true);
    expect(body.results.length).toBeGreaterThan(0);

    // The keyword-matching entry ranks; the unrelated cafeteria entry does not
    // (FR-014's relevance floor drops it — no shared keywords or dense support).
    const contents: string[] = body.results.map((r: { content: string }) => r.content);
    expect(contents.some((c) => /kubernetes/i.test(c))).toBe(true);
    expect(contents.some((c) => /cafeteria/i.test(c))).toBe(false);

    // Provenance (FR-015) + lifecycle state (FR-019) on every result.
    for (const r of body.results as { source: string; state?: string; score: number }[]) {
      expect(r.source).toMatch(/#entry-\d+$/);
      expect(r.state).toBe("active");
      expect(typeof r.score).toBe("number");
    }
  });

  test("FR-014: a query with no real support returns an empty result, not a guess", async ({ request }) => {
    const res = await request.get(
      `/api/memory/search?agent=${SEARCH_AGENT}&q=${encodeURIComponent("xyzzy nonexistent qwertyzzzz")}`,
    );
    expect(res.ok()).toBe(true);
    const body = await res.json();
    expect(body.results).toHaveLength(0);
  });
});

// ── US4 — Settings surface: Embeddings subsection vs mockup.html ──────────

test.describe("Settings — AI Provider — Embeddings subsection (028)", () => {
  test("renders per mockup.html: fields, per-field fallback hints, new badge, availability", async ({ page }) => {
    test.setTimeout(120_000);
    await page.getByTestId("dock-settings").click();
    const win = page.getByTestId("window-settings");
    await expect(win).toBeVisible({ timeout: 20000 });
    await win.getByRole("button", { name: "AI Provider" }).click();

    await expect(win.getByText("Embeddings", { exact: true })).toBeVisible();
    await expect(win.getByText("new", { exact: true })).toBeVisible();

    // Deterministic: force Anthropic — no first-party embeddings endpoint.
    await win.locator("select").first().selectOption("anthropic");
    await expect(win.getByText(/No standard Anthropic embedding model/)).toBeVisible();
    await expect(win.getByText(/embeddings: not supported from this endpoint/i)).toBeVisible();

    // Base URL: per-field fallback hint + "Uses: <resolved>" placeholder.
    await expect(win.getByPlaceholder(/^Uses: /)).toBeVisible();
    await expect(win.getByText("Leave blank to use the LLM provider's base URL above.")).toBeVisible();

    // API key: password field, never shows a value; fallback indicator when unset.
    await expect(win.getByText("fallback", { exact: true })).toBeVisible();
    await expect(win.getByText("Leave blank to use the LLM provider's API key above.")).toBeVisible();

    // Model: "required" badge.
    await expect(win.getByText("required", { exact: true })).toBeVisible();

    // Switching to OpenAI shows its per-provider default model + inferred availability.
    await win.locator("select").first().selectOption("openai");
    await expect(win.locator('label:has-text("Model") + input')).toHaveValue("text-embedding-3-small");
    await expect(win.getByText(/embeddings: available/i)).toBeVisible();
    await expect(win.getByText(/defaults to/i)).toBeVisible();
  });

  test("the embedding API key is never present in the config-registry view (R8/S5)", async ({ request }) => {
    const res = await request.get("/api/config");
    const body = await res.json();
    const aiProvider = (body.schemas as { namespace: string; values: Record<string, unknown>; secretsSet: Record<string, boolean> }[]).find(
      (s) => s.namespace === "ai-provider",
    );
    expect(aiProvider).toBeTruthy();
    expect(aiProvider!.values["embeddings.apiKey"]).toBe("");
    expect(typeof aiProvider!.secretsSet["embeddings.apiKey"]).toBe("boolean");
  });

  test("the provider view never exposes the embedding key value (FR-011)", async ({ request }) => {
    const res = await request.get("/api/agent/provider");
    const body = await res.json();
    expect(body.config).not.toHaveProperty("embeddingsApiKey");
    expect(body.config).not.toHaveProperty("embeddings");
    expect(typeof body.config.hasEmbeddingKey).toBe("boolean");
    expect(typeof body.config.embedBaseUrl).toBe("string");
  });
});
