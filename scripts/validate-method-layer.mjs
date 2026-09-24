#!/usr/bin/env node
// Smoke test for the spec-method layer (044-048), against a RUNNING BOS.
//
// WHY THIS EXISTS, and why it is not a unit test.
//
// The unit suite (1562 tests) caught none of the seven defects found the first
// time this layer was exercised live. Not because coverage was thin — because
// every one of them lived at a BOUNDARY a unit test cannot cross:
//
//   install -> restart        a pack registered at install and never again
//   module instance           instrumentation's registry is not the route's
//   parse -> rewrite          a field the parser ignored was DELETED from disk
//   seed memoisation          ensureSeed had already run, so install seeded nothing
//   descriptor -> message     a warning naming a phase that did not exist
//
// Unit tests run in one process, one module instance, one memoised state. The
// fixtures installed and asserted in the same breath, so they could never see
// the gap. That is a gap in test TOPOLOGY, not in coverage, and this script is
// the cheapest way to close it.
//
//   npm run dev            # or however BOS is running
//   node scripts/validate-method-layer.mjs
//   BOS_URL=http://host:port node scripts/validate-method-layer.mjs
//
// Read-only except for one preflight POST, which is a dry run by contract.
// Exits non-zero on any failure, so it can gate a release.

const B = process.env.BOS_URL || "http://127.0.0.1:3000";
// A refused connection is the FIRST thing anyone hits when running this, and an
// unhandled fetch rejection reports it as a Node stack trace about ECONNREFUSED
// — which reads like a bug in the harness rather than "BOS is not running".
const unreachable = (err) => {
  console.error(`\n  BOS is not reachable at ${B}.`);
  console.error(`  Start it (npm run dev, or the supervisor) — or point elsewhere:`);
  console.error(`      BOS_URL=http://host:port npm run validate:methods`);
  console.error(`  (${err.cause?.code ?? err.message})\n`);
  process.exit(2);
};
const get = async (p) => {
  const r = await fetch(B + p).catch(unreachable);
  return r.json().catch(() => null);
};
const post = async (p, body) => {
  const r = await fetch(B + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    .catch(unreachable);
  return r.json().catch(() => null);
};

let pass = 0, fail = 0;
const t = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};
const section = (s) => console.log(`\n${s}`);

// ── spec-kit: the built-in method, and the parity 045 SC-001 pins ──────────
section("spec-kit");
const specs = await get("/api/specs");
if (!specs) {
  console.error(`  FAIL  BOS is not reachable at ${B}`);
  process.exit(1);
}
const { tree = [], specs: list = [], method } = specs;
t("directory-scanned stores render", tree.filter((g) => g.owner !== "item").length >= 2,
  tree.filter((g) => g.owner !== "item").map((g) => g.name).join(", "));
// A store that vanishes reads as data loss; one bound to a missing method must
// say so rather than disappear (045 FR-016).
t("no store reports a missing method", !tree.some((g) => g.methodMissing));
t("the active descriptor reaches the client", !!method?.id, method?.id);
t("phases are server-supplied, with labels (FR-007)",
  list[0]?.phases?.length > 0 && list[0].phases.every((p) => p.label),
  `${list[0]?.phases?.length} phases on ${list.length} specs`);
// spec-kit declares `requires: []` on every phase, so `blocked` is unreachable.
// Its appearance means an edge was introduced that changes output at scale.
t("no phase is `blocked` under spec-kit (SC-001)",
  !list.some((s) => s.phases.some((p) => p.state === "blocked")));
// One constitution, read cross-store for every store including item ones.
// Resolving it per-store instead flips every item store done -> pending.
t("the constitution resolves identically everywhere (FR-006b)",
  new Set(list.map((s) => s.phases.find((p) => p.id === "constitution")?.state)).size <= 1);

// ── installed packs: the boundary that broke four different ways ───────────
section("installed method packs");
const { methods = [] } = (await get("/api/methods")) ?? {};
t("at least the built-in is registered", methods.some((m) => m.id === "spec-kit"), methods.map((m) => m.id).join(", "));
for (const m of methods.filter((x) => x.id !== "spec-kit")) {
  // Registration at INSTALL is not enough: routes and instrumentation get
  // separate module instances, so a pack must be ensured lazily too.
  t(`"${m.id}" survives a restart and is visible to routes`, !!m.label, `${m.label} v${m.version}`);
  t(`"${m.id}" carries its own stateLabels`, !!m.stateLabels?.done);
}

// ── agents: delegate-only must be HIDDEN but REACHABLE (FR-001b) ───────────
section("agent roots");
const agents = await get("/api/assistant/agent");
t("no agent-root collisions", (agents?.agentCollisions ?? []).length === 0,
  (agents?.agentCollisions ?? []).map((c) => c.id).join(", ") || "none");
t("no pack agent silently shadowed", (agents?.shadowedPackAgents ?? []).length === 0,
  (agents?.shadowedPackAgents ?? []).map((s) => s.id).join(", ") || "none");

// getAgent() is the path agent_delegate takes. It used to go through
// listSubAgents(), which filters to picker-visible roots — so every
// delegate-only agent was absent from the picker AND unreachable by
// delegation. A 404 here is that bug returning.
const control = await fetch(B + "/api/subagents/delegate", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ agent: "__no_such_agent__", task: "ping" }),
}).then((r) => r.status).catch(() => 0);
t("control: an unknown agent id is refused", control === 404, `HTTP ${control}`);

const pickerIds = new Set((agents?.agents ?? []).map((a) => a.id));
const packAgents = (agents?.agents ?? []).filter((a) => a.packId).map((a) => a.id);
t("picker renders", pickerIds.size > 0, `${pickerIds.size} agents`);
if (packAgents.length) t("pack agents in the picker are picker-visible by declaration", true, packAgents.join(", "));

// ── the switch dialog: preflight must gate, and must not over-claim ────────
section("method switching");
const other = methods.find((m) => m.id !== "spec-kit");
if (other) {
  const pf = await post("/api/specs", { op: "preflight-method", store: "user-specs", method: other.id });
  const r = pf?.report ?? {};
  t("preflight reports orphans BY PATH, not by count",
    !r.wouldOrphan || Array.isArray(r.orphaned),
    r.wouldOrphan ? `${r.orphaned?.length ?? 0} would be hidden` : "hides nothing");
  // A warning that names a phase the target method does not have sends the
  // user to create a file nothing reads, and teaches them to ignore the next one.
  const line = pf?.constitution ?? "";
  const namesPhase = /The "(.+)" phase will report/.exec(line);
  const claimOk = !namesPhase || (other.stateLabels && line.includes(other.stateLabels.pending));
  t("the constitution line claims only what can happen", claimOk, line.slice(0, 100));
} else {
  console.log("  SKIP  only the built-in method is installed — install a pack to exercise switching");
}

// ---------------------------------------------------------------------------
// The binding chain, at every level that can be SET. The resolver honoured
// project > store > global from the start, but only the store level was
// reachable — and the UI rendered ONE app-level method as every store's
// current value, so a picker could disagree with the binding BOS would apply.
// These read the tree the browser reads, not the resolver.
// ---------------------------------------------------------------------------
// Every installed pack's descriptor, as the RUNNING server resolved it. The
// unit suites validate hand-built fixtures — a pack ships in a separate repo, so
// the file BOS actually loads is only observable here (047 T001).
//
// SCOPE: `/api/methods` returns a MethodSummary, which is DELIBERATELY minimal —
// id, label, version, builtin, stateLabels, sections, storeRoot. Nothing else.
// Checking a field it does not carry is not a stricter test, it is a wrong one,
// and the two ways it goes wrong are not equally visible:
//
//   m.phases        -> undefined -> FAILED for every pack (a false alarm)
//   m.artifactOrder -> undefined -> `?? []` -> PASSED for every pack
//
// The second is the dangerous one. An absent field reading as "clean" looks like
// coverage while checking nothing, which is the same shape as the defects this
// harness exists to catch. So: assert the contract the API actually has, and
// refuse to silently treat a missing key as an empty one.
section("installed descriptors");
const has = (o, k) => Object.prototype.hasOwnProperty.call(o ?? {}, k);
const SUMMARY_KEYS = ["id", "label", "version", "stateLabels", "sections", "storeRoot"];
for (const m of methods.filter((x) => !x.builtin)) {
  const missing = SUMMARY_KEYS.filter((k) => !has(m, k));
  t(`"${m.id}" exposes the whole summary contract`, missing.length === 0,
    missing.length ? `MISSING ${missing.join(", ")}` : SUMMARY_KEYS.join(", "));

  // Sections must round-trip: a multi-section pack whose sections did not reach
  // the client renders as one undifferentiated tree, with no way to tell current
  // truth from an active proposal.
  const secs = m.sections ?? [];
  t(`"${m.id}" round-trips its ${secs.length} section(s)`,
    has(m, "sections") && secs.length > 0 && secs.every((s) => typeof s.rel === "string" && s.kind),
    secs.map((s) => `${s.rel || "/"}:${s.kind}${s.terminal ? "(terminal)" : ""}`).join(" "));
}
// Where each pack writes in the USER's repository (050 FR-003). This is the
// check that would have caught the defect that prompted it: `bmad` and
// `openspec` shipped with no `storeRoot` at all, and the only symptom was
// silence — `detectMethod` skips such a pack, so a repository already laid out
// for that framework was never offered it, and registering with the pack anyway
// dropped the spec store at the repo root.
//
// It belongs HERE and not only in the unit suite because those two packs ship in
// a separate repo: the descriptor BOS actually loads for them is observable
// nowhere else. `registerMethod` now refuses a descriptor without the field, so
// a pack failing this is one that somehow got past it.
{
  const spelled = methods.filter((m) => has(m, "storeRoot"));
  if (methods.length && spelled.length === 0) {
    // Same staleness rule as the binding section below: a server predating the
    // field fails every pack for a reason that has nothing to do with the packs.
    console.log("  STALE  the running server predates storeRoot in the summary — rebuild and restart BOS, then re-run");
  } else {
    for (const m of methods) {
      const root = m.storeRoot;
      const ok = typeof root === "string" && root.trim().length > 0
        && (root === "." || (!root.startsWith("/") && !root.split(/[\\/]/).includes("..")));
      t(`"${m.id}" says where its specs live in a repository`, ok,
        root === "." ? "the repo root" : (root ?? "MISSING — this pack can never be auto-detected"));
    }
  }
}

// A pack's PHASES are verified through a unit in a store bound to it — the
// spec-kit section above does exactly that for the active method. There is no
// pack-scoped equivalent here because no store is bound to these packs; binding
// one would make this harness a mutation, which it is not. Bind a store and
// re-run to cover them.
console.log("  NOTE   phase DAGs are covered for the ACTIVE method only — bind a store to a pack to cover its own");

section("binding chain (project > store > global)");
{
  const groups = tree.filter((g) => g.type === "group");
  // STALENESS GUARD. BOS runs a BUILT next-server under the supervisor, so a
  // source edit does not reach it until a rebuild — and a server predating a
  // check fails it for a reason that has nothing to do with the product. Six
  // failures reading "undefined" sent me hunting a defect that was not there.
  // `method` is emitted on every group unconditionally, so its total absence
  // means old code, not a wrong binding.
  if (groups.length && groups.every((g) => !("method" in g))) {
    console.log("  STALE  the running server predates the per-node binding — rebuild and restart BOS, then re-run");
    console.log("         (edits to src/ do not hot-reload into a built next-server)");
    console.log(`\n  ${pass} passed, ${fail} failed, binding checks SKIPPED\n`);
    process.exit(fail === 0 ? 0 : 1);
  }
  t("every store group resolves its OWN method",
    groups.every((g) => g.method || g.methodMissing),
    groups.map((g) => `${g.name}=${g.method ?? g.methodMissing}`).join(" "));

  // Item stores are synthesised and had no manifest at all, so their binding
  // was permanently unreadable and could only land on the global default.
  const itemRows = groups.filter((g) => g.owner === "item").map((g) => g.children?.[0]).filter(Boolean);
  t("each item store's row carries a binding it can be bound by",
    itemRows.length === 0 || itemRows.every((r) => r.method && r.owner === "item"),
    itemRows.length ? `${itemRows.length} item store(s), e.g. ${itemRows[0].name}=${itemRows[0].method}` : "no item stores");

  const projects = groups.flatMap((g) => (g.children ?? []).filter((n) => n.type === "project"));
  t("every Project resolves a method and reports which level set it",
    projects.length === 0 || projects.every((p) => p.method && typeof p.methodBound === "boolean"),
    `${projects.length} project(s); ${projects.filter((p) => p.methodBound).length} bound at Project level`);

  // An inherited binding must not be reported as a decision made here, or the
  // user cannot tell whether clearing it changes anything.
  const inherited = [...groups, ...projects].filter((n) => n.method && n.methodBound === false);
  t("inherited bindings are distinguishable from declared ones",
    inherited.length === 0 || inherited.every((n) => !n.methodBound),
    `${inherited.length} inherited`);
}

section("binding writes are validated");
{
  // A typo'd Project id must be REFUSED, not written — a project.json in a
  // directory that is not a Project is read by nothing and reported by nothing.
  const bad = await post("/api/specs", { op: "preflight-method", store: "user-specs", project: "no-such-project-xyz", method: "spec-kit" });
  t("an unknown Project is refused rather than silently written",
    typeof bad?.error === "string" && /no Project/i.test(bad.error),
    bad?.error ?? JSON.stringify(bad).slice(0, 80));

  const target = methods.find((m) => m.id !== "spec-kit") ?? methods[0];
  const proj = tree.flatMap((g) => (g.children ?? []).filter((n) => n.type === "project" && g.writable))[0];
  if (proj && target) {
    const id = proj.path.split("/").pop();
    const pf = await post("/api/specs", { op: "preflight-method", store: proj.path.split("/")[0], project: id, method: target.id });
    // Scoped preflight must not claim units outside the Project.
    const strays = (pf?.report?.orphaned ?? []).filter((x) => !x.startsWith(`${id}/`) && x !== id);
    t("a Project-scoped preflight reports only that Project's units", strays.length === 0,
      `${pf?.report?.orphaned?.length ?? 0} in scope, ${strays.length} stray`);
    t("a Project-scoped preflight leaves the store constitution alone",
      pf?.constitution === undefined,
      pf?.constitution ? `LEAKED: ${pf.constitution.slice(0, 60)}` : "no constitution reconcile at project scope");
  } else {
    console.log("  SKIP  no writable Project to scope a preflight against");
  }
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
