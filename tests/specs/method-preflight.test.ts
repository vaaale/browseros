// 045 T018/T024 — preflight (FR-010, FR-010a, FR-010c, SC-005, SC-010) and the
// install origin gate (FR-013a, SC-016).
//   npm run test:unit -- tests/specs/method-preflight.test.ts
import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { join } from "path";
import { mkdirSync, writeFileSync } from "fs";
import { execFileSync } from "child_process";
import { useTestDataDir } from "../services/_test-env";
import { specsRoot } from "../../src/os/specs-dir";
import { ensureStores } from "../../src/lib/specs/seed";
import { preflightMethodChange, describePreflight } from "../../src/lib/specs/method/preflight";
import { requiresOriginOptIn, hasOriginOptIn, recordOriginOptIn, revokeOriginOptIn } from "../../src/lib/specs/method/install";
// 046 T006: the descriptor is the PACK's method.json now, not a TS module.
import { loadBuiltinDescriptor } from "../../src/lib/specs/method/builtin-pack";
const SPEC_KIT = loadBuiltinDescriptor();
import type { MethodDescriptor } from "../../src/lib/specs/method/types";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}
function write(root: string, rel: string, body: string): void {
  const p = join(root, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, body);
}

/** A descriptor identical to spec-kit but keyed on a different leaf marker —
 *  the realistic shape of an incompatible method change. */
const OTHER: MethodDescriptor = { ...SPEC_KIT, id: "other", label: "Other", sections: [{ rel: "", kind: "active", leafMarker: "proposal.md", numbering: "none" }] };

async function corpus(): Promise<string> {
  await ensureStores();
  const userSpecs = join(specsRoot(), "user-specs");
  write(userSpecs, "alpha/project.json", JSON.stringify({ label: "Alpha" }));
  write(userSpecs, "alpha/001-one/spec.md", "# One\n");
  write(userSpecs, "alpha/002-two/spec.md", "# Two\n");
  write(userSpecs, "alpha/003-proposal/proposal.md", "# Under the other method\n");
  git(userSpecs, ["add", "-A"]);
  git(userSpecs, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "corpus"]);
  return userSpecs;
}

test("SC-005 — a method change that would hide content reports WHICH paths, not a count", async () => {
  const { cleanup } = useTestDataDir("preflight-orphan");
  try {
    await corpus();
    const r = await preflightMethodChange("user-specs", SPEC_KIT, OTHER);

    expect(r.wouldOrphan, "switching leaf markers hides every spec.md feature").toBe(true);
    expect(r.orphaned).toEqual(["alpha/001-one", "alpha/002-two"]);
    // …and it reports what the new method WOULD find, so the user can see the
    // change is a swap rather than pure loss.
    expect(r.gained).toEqual(["alpha/003-proposal"]);

    const text = describePreflight(r);
    expect(text, "paths, not just a count — '2 features' tells nobody whether they matter").toContain("alpha/001-one");
    expect(text).toContain("alpha/002-two");
    expect(text, "must say the content is not deleted").toMatch(/not deleted/i);
    // FR-010's documentation clause: the recommended path is a NEW store or
    // Project, not converting one in place.
    expect(text).toMatch(/new store or Project/i);
  } finally {
    cleanup();
  }
});

test("a no-op change reports no orphans", async () => {
  const { cleanup } = useTestDataDir("preflight-noop");
  try {
    await corpus();
    const r = await preflightMethodChange("user-specs", SPEC_KIT, { ...SPEC_KIT, id: "spec-kit-2" });
    expect(r.wouldOrphan).toBe(false);
    expect(r.orphaned).toEqual([]);
    expect(describePreflight(r)).toMatch(/hides nothing/);
  } finally {
    cleanup();
  }
});

test("FR-010a — draft-branch-only units are reported SEPARATELY", async () => {
  // These are what a user is most likely working on right now and least likely
  // to notice vanishing, and a listing-based walk cannot see them at all —
  // they have no base copy.
  const { cleanup } = useTestDataDir("preflight-branch");
  try {
    const userSpecs = await corpus();
    const base = git(userSpecs, ["rev-parse", "--abbrev-ref", "HEAD"]);
    git(userSpecs, ["checkout", "-q", "-b", "bos/testfixture-wip"]);
    write(userSpecs, "alpha/004-draft/spec.md", "# Draft in progress\n");
    git(userSpecs, ["add", "-A"]);
    git(userSpecs, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "draft"]);
    git(userSpecs, ["checkout", "-q", base]);

    const r = await preflightMethodChange("user-specs", SPEC_KIT, OTHER);
    expect(r.orphanedOnBranch, "the in-progress draft must be called out").toContain("alpha/004-draft");
    expect(describePreflight(r)).toMatch(/draft feature branch/i);
  } finally {
    cleanup();
  }
});

test("SC-016 — the origin gate: plugin-bearing packs from a marketplace need a per-pack opt-in", async () => {
  const { cleanup } = useTestDataDir("preflight-origin");
  try {
    // Same pack, two origins. From the user's own user-apps it is their own
    // work and installs freely; from a marketplace it is third-party
    // server-side code.
    expect(requiresOriginOptIn({ plugin: true }, "local"), "own user-apps needs no ceremony").toBe(false);
    expect(requiresOriginOptIn({ plugin: true }, "marketplace")).toBe(true);
    // A pack with NO plugin facet is just data — no gate either way.
    expect(requiresOriginOptIn({ plugin: false }, "marketplace")).toBe(false);

    // The opt-in is recorded PER PACK, not as a global "allow plugin packs"
    // switch that would silently cover every future pack.
    expect(await hasOriginOptIn("openspec")).toBe(false);
    await recordOriginOptIn("openspec");
    expect(await hasOriginOptIn("openspec")).toBe(true);
    expect(await hasOriginOptIn("bmad"), "opting into one pack must not opt into another").toBe(false);

    await recordOriginOptIn("openspec"); // idempotent
    await revokeOriginOptIn("openspec");
    expect(await hasOriginOptIn("openspec")).toBe(false);
  } finally {
    cleanup();
  }
});

test("FR-008 — a Project-scoped preflight reports only THAT project's units", async () => {
  // A per-Project binding cannot affect the rest of the store, so counting the
  // whole store's units as orphaned would turn a safe, narrow change into an
  // alarming wall of false losses — and the report is the GATE, so false
  // orphans do not merely mislead, they force the user through the scary
  // "hide N unit(s) and switch anyway" override to do something harmless.
  const { cleanup } = useTestDataDir("preflight-project-scope");
  try {
    const userSpecs = await corpus();
    write(userSpecs, "beta/project.json", JSON.stringify({ label: "Beta" }));
    write(userSpecs, "beta/001-elsewhere/spec.md", "# Elsewhere\n");
    git(userSpecs, ["add", "-A"]);
    git(userSpecs, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "beta"]);

    const scoped = await preflightMethodChange("user-specs", SPEC_KIT, OTHER, "alpha");
    expect(scoped.orphaned, "alpha's spec.md leaves only").toEqual(["alpha/001-one", "alpha/002-two"]);
    expect(scoped.orphaned.some((p) => p.startsWith("beta/")), "beta is bound separately and untouched").toBe(false);
    expect(scoped.storeId, "the report names the scope it actually checked").toBe("user-specs/alpha");

    // Unscoped is the control: the SAME change at store level does hit beta.
    const whole = await preflightMethodChange("user-specs", SPEC_KIT, OTHER);
    expect(whole.orphaned).toContain("beta/001-elsewhere");
  } finally {
    cleanup();
  }
});
