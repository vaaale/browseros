// Task 4.6 (part 2) — No transcript writes, for spec 022 SC-006.
//
// The client-owned transcript at /Documents/Chats/<id>.json is authoritative
// and must never be written by the compaction module. This test greps every
// compaction source file for direct paths that would violate SC-006.
//
//   node --test --experimental-strip-types tests/compaction/no-transcript-writes.test.ts

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { promises as fs } from "node:fs";
import path from "node:path";

const COMPACTION_ROOT = path.resolve(__dirname, "..", "..", "src", "lib", "agent", "compaction");
const API_ROOT = path.resolve(__dirname, "..", "..", "src", "app", "api", "compaction");

async function readSources(dir: string): Promise<{ file: string; text: string }[]> {
  const out: { file: string; text: string }[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (!e.name.endsWith(".ts")) continue;
    const p = path.join(dir, e.name);
    out.push({ file: p, text: await fs.readFile(p, "utf8") });
  }
  return out;
}

describe("Task 4.6 — SC-006 no writes to /Documents/Chats", () => {
  it("compaction sources never call writer APIs on /Documents/Chats", async () => {
    const sources = [...(await readSources(COMPACTION_ROOT)), ...(await readSources(API_ROOT))];
    for (const { file, text } of sources) {
      // Any write-side call that names the Chats path is a spec violation.
      const bad = /(writeText|writeBytes|writeFileAtomic|writeFile|unlink|rm)\s*\([^)]*\/Documents\/Chats/;
      assert.equal(bad.test(text), false, `SC-006 violation in ${file}: ${(text.match(bad) || [""])[0]}`);
      // Also disallow raw concatenation of that path with any writer helper.
      const badConcat = /\/Documents\/Chats[^\n]*\b(write|append|unlink|rm)\b/;
      assert.equal(badConcat.test(text), false, `SC-006 concat violation in ${file}`);
    }
  });

  it("compaction sidecar lives under data/memory/compaction, not under VFS", async () => {
    const sidecar = await fs.readFile(path.join(COMPACTION_ROOT, "sidecar.ts"), "utf8");
    assert.match(sidecar, /"memory", "compaction"/, "sidecar path is data/memory/compaction");
    assert.equal(/\/Documents\//.test(sidecar), false, "sidecar file must not reference /Documents/");
  });
});
