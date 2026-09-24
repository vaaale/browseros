// 045 T005 — the method registry (FR-003a, SC-015).
//   npm run test:unit -- tests/specs/method-registry.test.ts
import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import {
  registerMethod, unregisterMethod, getMethod, listMethods, __resetMethodsForTest, MethodSchemaError,
} from "../../src/lib/specs/method/registry";
import { METHOD_SCHEMA_VERSION, type MethodDescriptor } from "../../src/lib/specs/method/types";
// 046 T006: the descriptor is the PACK's method.json now, not a TS module.
import { loadBuiltinDescriptor } from "../../src/lib/specs/method/builtin-pack";
const SPEC_KIT = loadBuiltinDescriptor();

function fixture(over: Partial<MethodDescriptor> = {}): MethodDescriptor {
  return {
    schemaVersion: METHOD_SCHEMA_VERSION,
    id: "fixture", label: "Fixture", version: "1.0.0",
    sections: [{ rel: "", kind: "active", leafMarker: "spec.md", numbering: "nnn-slug" }],
    constitution: "c.md", constitutionRoot: "system",
    discrepancies: { rel: "d.md", roots: ["own"] },
    artifacts: [], artifactOrder: [],
    phases: [{ id: "p", label: "P", requires: [], rules: [], else: "pending" }],
    stateLabels: { done: "Done", pending: "Pending", blocked: "Blocked", na: "N/A" },
    templates: "templates", storeRoot: "specs", agents: [], roles: {},
    ...over,
  };
}

test("register / get / list / unregister", () => {
  __resetMethodsForTest();
  registerMethod(fixture({ id: "b" }));
  registerMethod(fixture({ id: "a" }));
  expect(listMethods().map((m) => m.id), "listed in a deterministic order, not install order").toEqual(["a", "b"]);
  expect(getMethod("a")?.id).toBe("a");
  expect(unregisterMethod("a")).toBe(true);
  expect(unregisterMethod("a"), "second removal reports nothing to remove").toBe(false);
  expect(getMethod("a")).toBeUndefined();
});

test("SC-015 — an unsupported schemaVersion is REFUSED, naming both versions", () => {
  __resetMethodsForTest();
  // Never default a missing or unrecognised field and continue: the descriptor
  // would register with fields BOS cannot interpret, and the first visible
  // symptom is a store rendering empty with no explanation. Failing at
  // registration puts the error where the cause is.
  for (const [version, expectation] of [
    [METHOD_SCHEMA_VERSION + 1, /newer than BOS/],
    [METHOD_SCHEMA_VERSION - 1, /older than BOS/],
  ] as const) {
    let err: Error | undefined;
    try {
      registerMethod(fixture({ id: "bad", schemaVersion: version }));
    } catch (e) {
      err = e as Error;
    }
    expect(err, `schemaVersion ${version} must be refused`).toBeInstanceOf(MethodSchemaError);
    expect(err!.message, "names the version the pack declared").toContain(String(version));
    expect(err!.message, "names the version BOS supports").toContain(String(METHOD_SCHEMA_VERSION));
    expect(err!.message).toMatch(expectation);
  }
  expect(getMethod("bad"), "a refused pack must not be half-registered").toBeUndefined();
});

test("a structurally empty descriptor is refused rather than registering a store that renders nothing", () => {
  __resetMethodsForTest();
  expect(() => registerMethod(fixture({ phases: [] }))).toThrow(/declares no phases/);
  expect(() => registerMethod(fixture({ sections: [] }))).toThrow(/declares no sections/);
  expect(() => registerMethod(fixture({ id: "" }))).toThrow(/no id/);
});

test("re-registering an id replaces it — a pack upgrade, not a duplicate", () => {
  __resetMethodsForTest();
  registerMethod(fixture({ id: "x", version: "1.0.0" }));
  registerMethod(fixture({ id: "x", version: "2.0.0" }));
  expect(listMethods()).toHaveLength(1);
  expect(getMethod("x")?.version).toBe("2.0.0");
});

test("the built-in spec-kit descriptor is a valid pack, with no privileged shape", () => {
  // SC-002: `builtin` is a display/uninstall flag, never a code path. If the
  // shipped descriptor could not survive the same registration every
  // marketplace pack goes through, the two would have diverged.
  __resetMethodsForTest();
  registerMethod(SPEC_KIT);
  expect(getMethod("spec-kit")?.builtin).toBe(true);
  expect(SPEC_KIT.phases).toHaveLength(12);
  // requires: [] on ALL TWELVE — gating lives in the clauses. Any edge makes
  // `blocked` reachable, and under the linear edges PHASE_ORDER suggests that
  // flips 120 live features na -> blocked. 051 added ui-design, design and
  // review; the rule is unchanged and applies to them too.
  expect(SPEC_KIT.phases.filter((p) => p.requires.length > 0)).toEqual([]);
  // An OPTIONAL phase must never resolve `pending`: optional means NOT OWED, and
  // a pending clause would put every feature without one into a debt it does not
  // have — 111 of 133, for ui-design. Done-or-na by construction.
  const uiDesign = SPEC_KIT.phases.find((p) => p.id === "ui-design")!;
  expect(uiDesign.optional).toBe(true);
  expect(uiDesign.rules.some((r) => r.then === "pending")).toBe(false);
  // design.md / test-results.md must stay OUT of artifactOrder: both fall to
  // the `99 -> localeCompare` tail, and 23 live features carry a design.md.
  expect(SPEC_KIT.artifactOrder).not.toContain("design.md");
  expect(SPEC_KIT.artifactOrder).not.toContain("test-results.md");
});

// Two shipped packs (bmad, openspec) went without a storeRoot and nothing
// noticed, because `storeRoot` was optional with "absent ⇒ the repo root" as its
// default — so "I write beside the code" and "I forgot to say" had the same
// spelling, and the only symptom was silence: detectMethod skips such a pack, so
// a repository already laid out for that framework was never offered it.
test("a descriptor that does not say where its specs go is REFUSED, naming the pack", () => {
  __resetMethodsForTest();
  const { storeRoot: _omitted, ...noRoot } = fixture({ id: "forgot" });
  expect(() => registerMethod(noRoot as MethodDescriptor)).toThrow(/"forgot".*storeRoot/s);
  expect(getMethod("forgot"), "and nothing half-registers").toBeUndefined();

  // Empty is the same failure to a pack author and reports as one — the rule
  // this file already applies to phases and sections.
  expect(() => registerMethod(fixture({ id: "blank", storeRoot: "   " }))).toThrow(/storeRoot/);

  // A path out of the repository is refused too. `storeRoot` decides where BOS
  // writes in the USER's source tree, so "../.." is not a location, it is an
  // escape.
  expect(() => registerMethod(fixture({ id: "escape", storeRoot: "../elsewhere" }))).toThrow(/escapes the repository/);
  expect(() => registerMethod(fixture({ id: "abs", storeRoot: "/etc" }))).toThrow(/escapes the repository/);
});

test('"." is the repo root, said out loud — and registers', () => {
  __resetMethodsForTest();
  // The case the old optional field could not express. A framework that writes
  // at the repo root must be able to SAY so, or refusing absence would just move
  // the ambiguity rather than remove it.
  registerMethod(fixture({ id: "rooted", storeRoot: "." }));
  expect(getMethod("rooted")?.storeRoot).toBe(".");
});

// BOS's own bundled packs are SOURCE, not data — in this repo, under
// seed/method-packs/ — so they can be read hermetically. The two packs that were
// missing this field live in the marketplace and are out of reach here; the
// registration gate above is what covers those, at install time.
test("every method pack BOS ships declares a usable storeRoot", async () => {
  const { readdirSync, existsSync, readFileSync } = await import("fs");
  const { join } = await import("path");
  const root = join(process.cwd(), "seed", "method-packs");
  const packs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
  expect(packs.length, "guards the guard — an empty sweep would pass vacuously").toBeGreaterThan(0);

  for (const pack of packs) {
    // The descriptor sits at the pack root or under method/, depending on the
    // pack's shape; both are real layouts (045 packaging).
    const candidates = [join(root, pack.name, "method.json"), join(root, pack.name, "method", "method.json")];
    const file = candidates.find((c) => existsSync(c));
    expect(file, `${pack.name} ships no method.json`).toBeTruthy();
    const descriptor = JSON.parse(readFileSync(file!, "utf8")) as MethodDescriptor;
    expect(typeof descriptor.storeRoot, `${pack.name} declares no storeRoot`).toBe("string");
    expect(descriptor.storeRoot.trim().length, `${pack.name} declares an empty storeRoot`).toBeGreaterThan(0);
  }
});
