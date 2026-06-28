import { test, expect } from "./fixtures";
import { makeToolMatcher } from "../src/lib/mcp/match";

// Deterministic smoke test for the MCP Servers settings tab. Verifies the tab
// renders and that the editor swaps fields per transport. Does not assert on a
// real connection (Test needs a reachable server / network).
test.describe("Settings — MCP Servers", () => {
  test("renders the editor and swaps fields by transport", async ({ page }) => {
    await page.getByTestId("dock-settings").click();
    const win = page.getByTestId("window-settings");
    await expect(win).toBeVisible();

    await win.getByRole("button", { name: "MCP Servers" }).click();

    // The add/edit form, the description field, and the Test button are present.
    await expect(win.getByPlaceholder("github-mcp-server")).toBeVisible();
    await expect(win.getByPlaceholder(/What this server is for/)).toBeVisible();
    await expect(win.getByRole("button", { name: "Test connection" })).toBeVisible();

    // Default transport is Streamable HTTP → the endpoint URL field shows.
    await expect(win.getByPlaceholder("https://example.com/mcp")).toBeVisible();

    // Switching to stdio shows command/args and hides the URL field.
    await win.locator("select").first().selectOption("stdio");
    await expect(win.getByPlaceholder("docker")).toBeVisible();
    await expect(win.getByPlaceholder("https://example.com/mcp")).toHaveCount(0);
  });

  // Exercises the test-without-save backend path (normalize → probe → stdio spawn)
  // with a command that does not exist, so it deterministically reports failure and
  // never persists anything.
  test("Test connection reports failure for an unreachable stdio command", async ({ request }) => {
    test.setTimeout(40_000);
    const res = await request.post("/api/mcp", {
      data: { test: true, name: "probe-smoke", transport: "stdio", command: "bos-no-such-command-xyz", args: [] },
    });
    const body = await res.json();
    expect(body.result?.ok).toBe(false);

    // It must not have been saved.
    const list = await (await request.get("/api/mcp")).json();
    expect((list.servers ?? []).some((s: { name: string }) => s.name === "probe-smoke")).toBe(false);
  });

  // The gateway rejects calls to a server the agent can't see (here: unknown).
  test("gateway callMcpServerTool rejects an unknown server", async ({ request }) => {
    const res = await request.post("/api/mcp/tools", {
      data: { server: "does-not-exist", tool: "anything", args: {} },
    });
    const body = await res.json();
    expect(body.error).toBeTruthy();
    expect(body.result).toBeUndefined();
  });
});

// Pure unit tests for the v1 tool matcher (014-mcp-tool-gateway). The matcher is
// the swappable seam for future semantic search.
test.describe("MCP gateway — tool matcher", () => {
  const tools = [
    { server: "gitlab", name: "list_projects", description: "List GitLab projects" },
    { server: "gitlab", name: "search_repositories", description: "Search repos" },
    { server: "gitlab", name: "create_issue", description: "Open an issue" },
  ];
  const run = (q: string) => tools.filter(makeToolMatcher(q)).map((t) => t.name);

  test("empty query matches everything", () => {
    expect(run("")).toEqual(["list_projects", "search_repositories", "create_issue"]);
  });
  test("substring matches name or description (case-insensitive)", () => {
    expect(run("repo")).toEqual(["search_repositories"]);
    expect(run("GITLAB")).toEqual(["list_projects"]); // only the one whose description has 'GitLab'
  });
  test("wildcards: * and ?", () => {
    expect(run("list_*")).toEqual(["list_projects"]);
    expect(run("*issue*")).toEqual(["create_issue"]);
  });
  test("no match returns nothing", () => {
    expect(run("zzz-nope")).toEqual([]);
  });
});
