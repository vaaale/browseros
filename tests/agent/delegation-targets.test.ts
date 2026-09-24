// Regression guard for 044-skill-agent-hygiene FR-001 / SC-001: every agent a
// seeded skill or agent delegates to must actually exist in `seed/agents/`.
//
// This is a GUARD, not a fix. All targets resolve today — the baseline is zero
// failures. It exists because 044 retires three skills and moves content
// between the rest, which is exactly the kind of change that orphans a
// delegation, and because `filterAllowed` (src/lib/agent/capabilities.ts) drops
// an unresolvable id SILENTLY: a broken `agent_delegate` target produces no
// error, no log, and no test failure anywhere else.
//
// Historical note worth keeping: an early draft of 044 asserted that
// `devil-s-advocate` was missing and built a whole requirement on it. It was
// present the entire time — the claim came from a stale directory listing that
// was never re-checked. This test is the mechanical answer to that class of
// mistake.
//   npm run test:unit -- tests/agent/delegation-targets.test.ts
import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { join } from "path";
import { readFileSync, readdirSync, statSync } from "fs";

const REPO_ROOT = join(__dirname, "..", "..");
const SEED_AGENTS = join(REPO_ROOT, "seed", "agents");
const SEED_SKILLS = join(REPO_ROOT, "seed", "skills");
// 046 relocated spec-kit's four process agents and its driver skill into the
// built-in method pack. They are still SHIPPED content that must resolve — the
// guard's subject is "does every delegation target exist", and the answer now
// spans two roots. Scanning only seed/ would make this test pass by looking in
// the wrong place, which is worse than failing.
const PACK_ROOT = join(REPO_ROOT, "seed", "method-packs");

/** `<pack>/agents` or `<pack>/skills` for every in-tree method pack. */
function packRoots(kind: "agents" | "skills"): string[] {
  try {
    return readdirSync(PACK_ROOT)
      .map((pack) => join(PACK_ROOT, pack, kind))
      .filter((p) => {
        try {
          return statSync(p).isDirectory();
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
}

/** Directory names directly under each of `roots`. */
function idsUnder(roots: string[]): Set<string> {
  const out = new Set<string>();
  for (const root of roots) {
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const name of entries) {
      try {
        if (statSync(join(root, name)).isDirectory()) out.add(name);
      } catch {
        /* unreadable entry is not this test's concern */
      }
    }
  }
  return out;
}

/** `agent_delegate( agent: "x" )` / `agent: "x"` across prose and code fences. */
const DELEGATE_TARGET = /agent:\s*"([a-z0-9][a-z0-9-]*)"/g;

function markdownFilesUnder(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return; // a seed root may legitimately not exist in a trimmed checkout
    }
    for (const name of entries) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith(".md")) out.push(p);
    }
  };
  walk(root);
  return out;
}

function seededAgentIds(): Set<string> {
  return idsUnder([SEED_AGENTS, ...packRoots("agents")]);
}

/** Every delegation target named anywhere in seeded content, with its source. */
function delegationTargets(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const roots = [SEED_SKILLS, SEED_AGENTS, ...packRoots("skills"), ...packRoots("agents")];
  for (const file of roots.flatMap(markdownFilesUnder)) {
    const body = readFileSync(file, "utf8");
    for (const m of body.matchAll(DELEGATE_TARGET)) {
      const id = m[1];
      const where = file.slice(REPO_ROOT.length + 1);
      const seen = found.get(id) ?? [];
      if (!seen.includes(where)) seen.push(where);
      found.set(id, seen);
    }
  }
  return found;
}

test("every delegation target in seeded content resolves to a seeded agent", () => {
  const agents = seededAgentIds();
  const targets = delegationTargets();

  // Guard the guard: if the scan finds nothing the assertion below is vacuous,
  // which is exactly how a regression test quietly stops testing anything.
  expect(targets.size, "found no agent_delegate targets at all — the scan is broken").toBeGreaterThan(0);

  const unresolved = [...targets.entries()]
    .filter(([id]) => !agents.has(id))
    .map(([id, files]) => `  ${id}  ← ${files.join(", ")}`);

  expect(
    unresolved,
    `delegation target(s) name an agent absent from seed/agents/:\n${unresolved.join("\n")}`,
  ).toEqual([]);
});

test("seeded agents' skills allowlists name only seeded skills", () => {
  // 044 FR-006a / SC-003a. `seed/` is the template BOS installs with, so an
  // allowlist entry pointing at a marketplace or item-bundled skill is dead on
  // a fresh install — and `filterAllowed` (src/lib/agent/capabilities.ts) drops
  // it silently, so the rot never surfaces.
  //
  // Deployments that DO install such a skill add it to their own copy of the
  // agent; the `.seed-rev` contract then marks that copy `local` and protects
  // the edit from being reconciled away.
  const seededSkills = idsUnder([SEED_SKILLS, ...packRoots("skills")]);
  expect(seededSkills.size, "found no seeded skills — the scan is broken").toBeGreaterThan(0);

  const rot: string[] = [];
  const agentRoots = [SEED_AGENTS, ...packRoots("agents")];
  for (const agentId of seededAgentIds()) {
    let body: string | undefined;
    for (const root of agentRoots) {
      try {
        body = readFileSync(join(root, agentId, "AGENT.md"), "utf8");
        break;
      } catch {
        /* try the next root */
      }
    }
    if (body === undefined) continue; // a directory without an AGENT.md is not this test's concern
    const declared = body.match(/^skills:\s*\[([^\]]*)\]/m);
    if (!declared) continue; // unset allowlist = inherit everything; nothing to check
    for (const raw of declared[1].split(",")) {
      const id = raw.trim();
      if (id && !seededSkills.has(id)) rot.push(`  ${agentId} → ${id}`);
    }
  }

  expect(
    rot,
    `allowlist entries naming a skill absent from seed/skills/:\n${rot.join("\n")}`,
  ).toEqual([]);
});
