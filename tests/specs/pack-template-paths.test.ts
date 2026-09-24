// 046 T017 — every relocated prompt's template path RESOLVES (FR-012, SC-007a).
//
// tasks.md calls for resolution rather than grep, and the distinction is the
// whole point: a grep proves a string was rewritten, not that anything is
// there. 046 moved the engine and rewrote every path that reads it; a typo in
// any one of them is a pipeline step that fails at runtime with an empty read,
// which is exactly the failure mode T013 warns is not a compile error.
//
// Written as a unit test rather than a browser e2e because it needs no browser:
// the question is whether a path names a file that exists on disk.
//   npm run test:unit -- tests/specs/pack-template-paths.test.ts
import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { builtinPackRoot, loadBuiltinDescriptor } from "../../src/lib/specs/method/builtin-pack";

const PACK = builtinPackRoot();
const MOUNT = "/Methods/spec-kit/templates";

/** Every `/Methods/spec-kit/templates/...` path mentioned in pack content. */
function referencedTemplatePaths(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith(".md")) {
        for (const m of readFileSync(p, "utf8").matchAll(/\/Methods\/spec-kit\/templates\/([A-Za-z0-9._/-]+)/g)) {
          const rel = m[1].replace(/[.,)]+$/, "");
          if (rel.includes("<")) continue; // a placeholder like <artifact>-template.md
          found.set(rel, [...(found.get(rel) ?? []), p.slice(PACK.length + 1)]);
        }
      }
    }
  };
  walk(PACK);
  return found;
}

test("SC-007a — every concrete template path in pack content resolves to a real file", () => {
  const refs = referencedTemplatePaths();
  // Guard the guard: if the scan finds nothing, the assertion below is vacuous.
  expect(refs.size, "found no template references at all — the scan is broken").toBeGreaterThanOrEqual(5);

  const missing = [...refs.entries()]
    .filter(([rel]) => !existsSync(join(PACK, "templates", rel)))
    .map(([rel, from]) => `  ${MOUNT}/${rel}  ← ${[...new Set(from)].join(", ")}`);

  expect(missing, `template path(s) that do not resolve:\n${missing.join("\n")}`).toEqual([]);
});

test("the descriptor's templates directory exists and holds the command prompts", () => {
  const d = loadBuiltinDescriptor();
  const dir = join(PACK, d.templates);
  expect(existsSync(dir), `${d.templates} must exist inside the pack`).toBe(true);
  // The nine pipeline steps each have a command prompt; the driver reads them
  // by name, so a missing one is a step that cannot run.
  for (const step of ["specify", "clarify", "plan", "tasks", "analyze", "implement", "converge", "constitution"]) {
    expect(existsSync(join(dir, "commands", `${step}.md`)), `commands/${step}.md`).toBe(true);
  }
  for (const tpl of ["spec-template.md", "plan-template.md", "tasks-template.md", "constitution-template.md"]) {
    expect(existsSync(join(dir, tpl)), tpl).toBe(true);
  }
});

test("no pack content still points at the deleted .specify/ engine", () => {
  // `.specify/memory/constitution.md` is the ONE surviving `.specify/` path: it
  // is spec CONTENT inside the system store, not engine, and FR-011 requires it
  // stay verbatim so nothing moves for existing stores.
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith(".md") || name.endsWith(".json")) {
        for (const line of readFileSync(p, "utf8").split("\n")) {
          if (line.includes(".specify/") && !line.includes(".specify/memory/constitution.md")) {
            offenders.push(`  ${p.slice(PACK.length + 1)}: ${line.trim().slice(0, 100)}`);
          }
        }
      }
    }
  };
  walk(PACK);
  expect(offenders, `pack content still referencing the deleted .specify/ engine:\n${offenders.join("\n")}`).toEqual([]);
});

test("SC-003 — .specify/ is gone from the source tree, and so is its write grant", () => {
  expect(existsSync(".specify"), "the directory must not exist").toBe(false);
  const repoFs = readFileSync("src/lib/dev/repo-fs.ts", "utf8");
  const allow = repoFs.match(/const WRITE_ALLOW_PREFIXES = \[([^\]]*)\]/)?.[1] ?? "";
  // A grant for a path that no longer exists is not harmless: it would silently
  // re-create the directory the moment anything wrote there.
  expect(allow, "`.specify/` must not remain writable").not.toContain(".specify/");
  expect(allow, "the pack lives under seed/ and must be writable instead").toContain("seed/");
});
