import "server-only";
import type { AssistantTool } from "../../tools";
import { serverTool, schema, p } from "./util";
import * as repo from "@/lib/dev/repo-fs";

// Read-only BOS source inspection, ported natively into v2 (025-agent-
// delegation-v2, Phase 4 — retiring the legacy engine): these used to be
// adapted from `src/lib/agent/subagents/tools.ts`'s `DEV_TOOLS` via
// `adaptLlmTools()`; now that nothing else needs `DEV_TOOLS` as a legacy
// `LlmTool` map, they're implemented directly as `AssistantTool`s, same
// `repo-fs.ts` implementations any delegated Developer agent already used.
// `dev_git_status` is NOT here — it already has its own native v2
// implementation in `tools/server/git.ts`. Write/branch ops are
// intentionally not here — source changes go through the Developer sub-agent
// on a feature branch.
export function devSourceTools(): Record<string, AssistantTool> {
  return {
    bos_source_list: serverTool(
      "bos_source_list",
      "List files/folders in the BrowserOS source repository (relative to repo root, e.g. 'src/components').",
      schema({ path: p.str("Repo-relative dir, defaults to '.'") }),
      async (input) => JSON.stringify(await repo.listDir((input.path as string) || ".")),
    ),
    bos_source_read: serverTool(
      "bos_source_read",
      "Read a source file from the BrowserOS repository (repo-relative path, e.g. 'src/components/apps/settings/SkillsTab.tsx').",
      schema({ path: p.str("Repo-relative file path") }, ["path"]),
      async (input) => repo.readFile(input.path as string),
    ),
    bos_source_search: serverTool(
      "bos_source_search",
      "Search BrowserOS source files for a string. Returns matching path:line:text. Optionally restrict to a subdirectory.",
      schema(
        { query: p.str("Search string"), dir: p.str("Subdir to search, defaults to 'src'") },
        ["query"],
      ),
      async (input) => JSON.stringify(await repo.search(input.query as string, { dir: input.dir as string | undefined })),
    ),
  };
}
