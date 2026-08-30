// web_fetch/file_to_markdown `output_path` — the mechanism that lets a document
// reach raw/ WITHOUT passing through the model (040 FR-024 / SC-007):
//   npx playwright test -c playwright.unit.config.ts tests/assistant/fetch-to-path.test.ts
//
// Without this, the only way to persist fetched content is to hand it back as
// `content:`, i.e. the model re-emitting the whole document as output tokens —
// exactly the cost the ingest redesign exists to remove. So the property under
// test is specifically: the receipt must NOT contain the document.

import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { useTestDataDir } from "../services/_test-env";
import { isWritableVfsPath, writeFetched } from "../../src/lib/assistant/tools/server/web-search";
import { readText } from "../../src/os/vfs";

test.describe("output_path — path validation", () => {
  test("accepts absolute VFS paths, rejects relative and traversal", () => {
    expect(isWritableVfsPath("/workspace/article.md")).toBe(true);
    expect(isWritableVfsPath("/Documents/a/b.md")).toBe(true);
    expect(isWritableVfsPath("workspace/article.md")).toBe(false);
    expect(isWritableVfsPath("/workspace/../../etc/passwd")).toBe(false);
    expect(isWritableVfsPath("/..")).toBe(false);
    expect(isWritableVfsPath("")).toBe(false);
  });
});

test.describe("output_path — receipt", () => {
  test("the receipt reports path and size WITHOUT echoing the content", async () => {
    const env = useTestDataDir("fetch-to-path");
    try {
      // A long, distinctive document: if any of it leaks into the receipt, the
      // whole point of output_path is defeated.
      const body = "SENTINEL_BODY_TEXT ".repeat(500);
      const receipt = await writeFetched("/workspace/article.md", "https://example.com/a", body);

      // Full fidelity to disk…
      expect(await readText("/workspace/article.md")).toBe(body);

      // …but never to the model.
      expect(receipt).not.toContain("SENTINEL_BODY_TEXT");
      expect(receipt).toContain("/workspace/article.md");
      expect(receipt).toContain(String(body.length));
      expect(receipt.length).toBeLessThan(400); // a receipt, not a document
    } finally {
      env.cleanup();
    }
  });
});
