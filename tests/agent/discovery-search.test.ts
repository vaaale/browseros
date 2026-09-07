// find_tools ranking (041-tool-groups, ADR-3). The old scorer matched the whole
// query string as a substring, so only its id-word rule ever fired for a real
// sentence; these tests exist to keep that from coming back.
//   npx playwright test -c playwright.unit.config.ts tests/agent/discovery-search.test.ts
import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { buildIndex, search, tokenize } from "../../src/lib/agent/discovery-search";
import { listCapabilities } from "../../src/lib/agent/capabilities-registry";
import { listToolGroups } from "../../src/lib/agent/tool-groups";
import { DISCOVERY_BENCHMARK, DISCOVERY_NEGATIVES, STOPWORD_TRAPS } from "./fixtures/discovery-benchmark";

const index = buildIndex(listCapabilities(), listToolGroups());
const ids = (q: string, n = 3) => search(q, index).results.slice(0, n).map((r) => r.id);

// ── Tokenizer ───────────────────────────────────────────────────────────────

test("tokenize drops stopwords and 1-char tokens", () => {
  expect(tokenize("send an email to a bob")).not.toContain("to");
  expect(tokenize("send an email to a bob")).not.toContain("an");
  expect(tokenize("a b c")).toEqual([]);
});

test("tokenize folds plurals and verb endings so query and corpus collide", () => {
  expect(tokenize("files")).toEqual(tokenize("file"));
  expect(tokenize("listing")).toEqual(tokenize("list"));
  expect(tokenize("searches")).toEqual(tokenize("search"));
  // ...without mangling words that merely end in the same letters.
  expect(tokenize("address")).toEqual(["address"]);
});

test("tokenize is deterministic and case-insensitive", () => {
  expect(tokenize("Send EMAIL")).toEqual(tokenize("send email"));
});

// ── The defect that motivated the rewrite ───────────────────────────────────

test("a multi-word natural-language query matches on description, not just id words", () => {
  // Shares no id word with the target; the old whole-query-substring scorer
  // could not return this at all.
  expect(ids("change my background picture")).toContain("bos_wallpaper_set");
});

// ── FR-018 / SC-005: stopwords must not create matches ──────────────────────

for (const trap of STOPWORD_TRAPS) {
  test(`"${trap.query}" must not surface ${trap.mustNotReturn} on a stopword`, () => {
    expect(search(trap.query, index).results.map((r) => r.id)).not.toContain(trap.mustNotReturn);
  });
}

// ── FR-017: rare terms outrank common ones ──────────────────────────────────

test("a discriminative term outranks a term shared by many tools", () => {
  // "list" appears in dozens of tools; "calendar" in a handful. The winner must
  // not have been chosen for the common word alone.
  const top = search("list calendar events", index).results[0];
  expect(top).toBeTruthy();
  expect(top.reasons.every((r) => r.term === "list")).toBe(false);
  expect(top.id.startsWith("calendar_")).toBe(true);
});

// ── FR-021: coverage bonus ──────────────────────────────────────────────────

test("matching more distinct query terms beats matching one term heavily", () => {
  const both = search("read a calendar event", index).results;
  const top = both[0];
  expect(top).toBeTruthy();
  expect(new Set(top.reasons.map((r) => r.term)).size).toBeGreaterThan(1);
});

// ── FR-023: every result explains itself ────────────────────────────────────

test("results carry the term and field that matched", () => {
  const top = search("delete a scheduled job", index).results[0];
  expect(top.reasons.length).toBeGreaterThan(0);
  for (const r of top.reasons) {
    expect(typeof r.term).toBe("string");
    expect(["id", "alias", "description", "group", "groupDescription"]).toContain(r.field);
  }
});

// ── FR-022: determinism ─────────────────────────────────────────────────────

test("ranking is byte-identical across repeated runs", () => {
  const a = search("send an email", index).results.map((r) => `${r.id}:${r.score}`);
  const b = search("send an email", index).results.map((r) => `${r.id}:${r.score}`);
  expect(a).toEqual(b);
});

// ── FR-027: unsearchable queries are reported, not silently empty ───────────

test("an all-stopword query is flagged unsearchable rather than returning []", () => {
  const out = search("what is the", index);
  expect(out.unsearchable).toBe(true);
  expect(out.results).toEqual([]);
});

// ── Gate + group scoping ────────────────────────────────────────────────────

test("eligible set restricts results without changing their order", () => {
  const eligible = new Set(["web_search", "web_fetch"]);
  const out = search("search the internet", index, { eligible });
  expect(out.results.every((r) => eligible.has(r.id))).toBe(true);
});

test("groupId scoping restricts to one group", () => {
  const out = search("read", index, { groupId: "files" });
  expect(out.results.length).toBeGreaterThan(0);
  const files = new Set(listCapabilities().filter((c) => c.group === "files").map((c) => c.id));
  expect(out.results.every((r) => files.has(r.id))).toBe(true);
});

// ── FR-034: a group-level query reaches that group's members ────────────────

test("naming a group in free text surfaces that group's tools", () => {
  const out = search("google calendar", index).results.slice(0, 5).map((r) => r.id);
  expect(out.some((id) => id.startsWith("calendar_"))).toBe(true);
});

// ── SC-004: the committed benchmark ─────────────────────────────────────────

test("SC-004 — every benchmark query puts its target in the top 3", () => {
  const misses: string[] = [];
  for (const c of DISCOVERY_BENCHMARK) {
    const top3 = ids(c.query, 3);
    if (!top3.includes(c.expectedId)) {
      const rank = search(c.query, index).results.findIndex((r) => r.id === c.expectedId);
      misses.push(`"${c.query}" → expected ${c.expectedId} (via ${c.via}); got [${top3.join(", ")}]; actual rank ${rank}`);
    }
  }
  expect(misses, `${misses.length}/${DISCOVERY_BENCHMARK.length} benchmark queries missed`).toEqual([]);
});

test("negative benchmark — an unrelated question returns nothing above the floor", () => {
  const noisy = DISCOVERY_NEGATIVES.filter((q) => search(q, index).results.length > 0).map(
    (q) => `"${q}" → [${ids(q, 3).join(", ")}]`,
  );
  expect(noisy, "queries with no matching capability must return no results").toEqual([]);
});
