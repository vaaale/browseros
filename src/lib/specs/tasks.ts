// The checklist parser, extracted from pipeline.ts by 045 so the method rule
// evaluator and the pipeline share ONE definition of "what a task item is".
//
// Framework-free (no `server-only`, no Node imports): evaluate.ts is pure over
// an injected reader, and pipeline.ts is server-only — importing the parser
// from pipeline would make the evaluator server-only too, and importing it the
// other way would be a cycle.

import type { Task } from "./types";

/** Parse `- [ ] T001 ...` / `- [x] ...` checklist items from a tasks.md body. */
export function parseTasks(content: string): Task[] {
  const out: Task[] = [];
  for (const line of content.split("\n")) {
    const m = line.match(/^\s*[-*]\s*\[([ xX])\]\s+(.*)$/);
    if (!m) continue;
    const text = m[2].trim();
    const idMatch = text.match(/^(T\d+[a-z]?)\b/);
    out.push({ id: idMatch ? idMatch[1] : "", text, done: m[1].toLowerCase() === "x" });
  }
  return out;
}
