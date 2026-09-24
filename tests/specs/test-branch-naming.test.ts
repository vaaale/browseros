// Test fixtures must not name feature branches after real features.
//
// A unit test running inside a live BOS creates REAL branches: the code paths
// under test are gated on `supervisorEnabled()`, and where that is true
// `specfs.writeFile({ branch })` POSTs `/__supervisor/begin`, which manufactures
// the branch, a worktree and a full clone of the data dir. (The guard in
// tests/_no-live-deployment.cjs now closes that channel — this file is the
// second line of defence, for the case where the guard is absent because the
// worktree running the tests is checked out at an older commit.)
//
// The branches that appeared on the production box were named
// `bos/follow-the-money`, `bos/agentic-editor-appearance`, `bos/history`,
// `bos/core-change`, `bos/project-layer`, `bos/file-tools-contract` — the
// actual feature branches those features were originally built on. Once they
// exist in the repo there is nothing to distinguish a fixture's debris from
// someone's real, unfinished work, so cleaning up means reading every branch
// and guessing. That is the cost this rule removes.
//
// THE RULE: a `bos/…` branch literal in test code starts with `bos/testfixture-`.
//
// Note the shape it has to fit: FEATURE_BRANCH_RE (src/lib/agent/feature-branch.ts)
// is /^bos\/[a-z0-9]+(?:-[a-z0-9]+){0,3}$/ — FOUR dash-separated segments, total.
// `testfixture` spends one, so a fixture branch gets at most three more.
// Longer names must be shortened, not prefixed onto.
//
//   npm run test:unit -- tests/specs/test-branch-naming.test.ts
import { test, expect } from "@playwright/test";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { FEATURE_BRANCH_RE } from "../../src/lib/agent/feature-branch";

const ROOT = join(__dirname, "..", "..");
const SCANNED = ["tests", "e2e"];
const PREFIX = "bos/testfixture-";

/**
 * Literals that are deliberately NOT fixture branch names and must keep their
 * exact spelling. Each entry needs a reason — this list is the only way to opt
 * out, so an unexplained addition is how the rule quietly stops working.
 */
const ALLOWED = new Map<string, string>([
  // Inputs to isFeatureBranch/requireFeatureBranch's own validation. Renaming
  // them would change what is under test: these strings are chosen to be
  // rejected (or accepted) for a specific reason.
  ["bos/claude", "validation input: the base branch is not a feature branch"],
  ["bos/Has-Upper", "validation input: must be rejected for uppercase"],
  ["bos/a-b-c-d-e", "validation input: must be rejected for >4 segments"],
  ["bos/good-name", "validation input: the accepted case"],
  // Produced by the product, not chosen by the test: selfHealBranch(caseId) in
  // src/lib/self-heal/types.ts returns `bos/self-heal-<caseId>`. A test
  // asserting that mapping has to spell the real output.
  ["bos/self-heal-", "product-generated prefix (selfHealBranch)"],
  ["bos/self-heal-0001", "product-generated: selfHealBranch('0001')"],
  ["bos/self-heal-0002", "product-generated: selfHealBranch('0002')"],
  ["bos/self-heal-0141", "product-generated: selfHealBranch('0141')"],
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    // Test scratch output, not source.
    if (entry.startsWith(".tmp")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(entry)) out.push(full);
  }
  return out;
}

const LITERAL = /["'`](bos\/[A-Za-z0-9._\-/]+)["'`]/g;

/** Branch literals in CODE. Comment lines are skipped on purpose: prose
 *  legitimately quotes the real historical branch names when explaining what
 *  went wrong, and rewriting that would destroy the explanation. */
function branchLiterals(): { branch: string; where: string }[] {
  const found: { branch: string; where: string }[] = [];
  for (const root of SCANNED) {
    for (const file of walk(join(ROOT, root))) {
      const rel = file.slice(ROOT.length + 1);
      readFileSync(file, "utf8").split("\n").forEach((line, i) => {
        const t = line.trimStart();
        if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return;
        for (const m of line.matchAll(LITERAL)) found.push({ branch: m[1], where: `${rel}:${i + 1}` });
      });
    }
  }
  return found;
}

test("every feature-branch literal in a test is marked as a fixture", () => {
  const offenders = branchLiterals()
    .filter(({ branch }) => !branch.startsWith(PREFIX) && !ALLOWED.has(branch))
    // `<branch>.provisioning` is a staging PATH, not a branch name.
    .filter(({ branch }) => !branch.endsWith(".provisioning") || !branch.slice(0, -".provisioning".length).startsWith(PREFIX));

  expect(
    offenders.map((o) => `${o.branch}  (${o.where})`).sort(),
    `Every bos/… branch a test uses must start with "${PREFIX}" so it is unmistakable in a real repo. ` +
      `These names collided with the actual feature branches the features were built on, which is why ` +
      `18 of them on a production box were indistinguishable from real work.`,
  ).toEqual([]);
});

test("every fixture branch is a VALID feature branch — the prefix costs a segment", () => {
  // FEATURE_BRANCH_RE allows four dash-separated segments. `testfixture` is
  // one of them, so a name with three more is the limit; a fourth makes the
  // branch unprovisionable and the test fails somewhere far from the cause.
  const invalid = branchLiterals()
    .filter(({ branch }) => branch.startsWith(PREFIX))
    // `<branch>.provisioning` is the clone layer's staging PATH, and the bare
    // prefix is this file's own constant — neither is a branch name.
    .map(({ branch, where }) => ({ branch: branch.replace(/\.provisioning$/, ""), where }))
    .filter(({ branch }) => branch !== PREFIX)
    .filter(({ branch }) => !FEATURE_BRANCH_RE.test(branch));

  expect(
    invalid.map((o) => `${o.branch}  (${o.where})`).sort(),
    `These exceed FEATURE_BRANCH_RE (${FEATURE_BRANCH_RE}) — shorten the name rather than adding segments.`,
  ).toEqual([]);
});

test("the allowlist stays small and every entry explains itself", () => {
  for (const [name, reason] of ALLOWED) {
    expect(reason.length, `allowlist entry "${name}" needs a real reason`).toBeGreaterThan(20);
  }
  // A growing allowlist is how this rule dies. If a new entry is genuinely
  // needed, raising this bound should be a deliberate, reviewed act.
  expect(ALLOWED.size, "allowlist has grown — is the new entry really not a fixture branch?").toBeLessThanOrEqual(8);
});
