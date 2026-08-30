// The local HTML→markdown converter behind web_fetch's fallback path:
//   npx playwright test -c playwright.unit.config.ts tests/assistant/html-to-markdown.test.ts
//
// This path runs whenever the configured provider has NO native web-fetch
// server tool (any non-Anthropic endpoint — self-hosted, OpenAI-compatible).
// The bar it must clear is "an agent can read this and follow its links": the
// previous implementation deleted every tag, which silently stripped every
// <a href> and left prose whose references had vanished.

import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { htmlToMarkdown } from "../../src/lib/net";

const PAGE = "https://example.com/posts/harness/";

test.describe("htmlToMarkdown", () => {
  test("preserves link targets and absolutizes relative hrefs", () => {
    const out = htmlToMarkdown(
      `<p>See the <a href="/posts/agents">agent post</a> and
       <a href="https://arxiv.org/abs/2401.00001">Foo et al. 2024</a>.</p>`,
      PAGE,
    );
    // A relative href is useless to a caller that wants to fetch it next.
    expect(out).toContain("[agent post](https://example.com/posts/agents)");
    expect(out).toContain("[Foo et al. 2024](https://arxiv.org/abs/2401.00001)");
  });

  test("drops script/style/head noise but keeps the title", () => {
    const out = htmlToMarkdown(
      `<html><head><title>Harness Engineering</title><style>.x{color:red}</style>
       <script>var secret=1;</script></head><body><p>Body text.</p></body></html>`,
      PAGE,
    );
    expect(out.startsWith("# Harness Engineering")).toBe(true);
    expect(out).toContain("Body text.");
    expect(out).not.toContain("color:red");
    expect(out).not.toContain("var secret");
  });

  test("decodes entities and keeps inline emphasis, lists and headings", () => {
    const out = htmlToMarkdown(
      `<h2>Section</h2><ul><li>First &amp; foremost</li><li>Foo&nbsp;et&nbsp;al.</li></ul>
       <p><strong>Bold</strong> <em>italic</em> <code>inline()</code></p>`,
      PAGE,
    );
    expect(out).toContain("## Section");
    expect(out).toContain("- First & foremost");
    expect(out).toContain("Foo et al.");
    expect(out).toContain("**Bold**");
    expect(out).toContain("*italic*");
    expect(out).toContain("`inline()`");
  });

  test("emits no empty links and de-links pure anchors", () => {
    const out = htmlToMarkdown(
      `<a href="/icon.png"><img src="i.png"></a><a href="#section">jump</a><a href="javascript:void(0)">js</a>`,
      PAGE,
    );
    // "[](url)" is pure noise; an in-page anchor is not a fetchable target.
    expect(out).not.toContain("[](");
    expect(out).toContain("jump");
    expect(out).not.toContain("(#section)");
    expect(out).toContain("js");
    expect(out).not.toContain("javascript:");
  });

  test("keeps block boundaries instead of collapsing the page to one line", () => {
    const out = htmlToMarkdown(`<p>One</p><p>Two</p><div>Three</div>`, PAGE);
    // The old converter collapsed all whitespace, fusing every paragraph.
    expect(out.split("\n").filter((l) => l.trim()).length).toBeGreaterThanOrEqual(3);
    expect(out).toContain("One");
    expect(out).toContain("Two");
    expect(out).toContain("Three");
  });

  test("is resilient to malformed markup", () => {
    const out = htmlToMarkdown(`<p>unclosed <a href="/x">link<div>next`, PAGE);
    expect(typeof out).toBe("string");
    expect(out).toContain("unclosed");
  });
});
