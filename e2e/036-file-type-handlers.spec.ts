import type { APIRequestContext, Page } from "@playwright/test";
import { test, expect } from "./fixtures";

// 036-file-type-handlers: the handler registry, "Open with" in the Files
// context menu, double-click opening a file with the selected handler, and
// html-viewer registered as the default text/html renderer.
//
// Each test works inside its own timestamped scratch folder under /Documents
// so runs stay isolated from each other and from the baseline VFS content, and
// removes it afterward. Tests that change the persisted per-type selection
// restore it (clear → back to the manifest default) in a finally block, since
// data/system/file-handlers.json is shared process state.

async function mkdir(request: APIRequestContext, vfsPath: string): Promise<void> {
  const res = await request.post("/api/fs", { data: { op: "mkdir", path: vfsPath } });
  expect(res.ok()).toBeTruthy();
}

async function writeFile(request: APIRequestContext, vfsPath: string, content: string): Promise<void> {
  const res = await request.post("/api/fs", { data: { op: "write", path: vfsPath, content } });
  expect(res.ok()).toBeTruthy();
}

async function removeVfsPath(request: APIRequestContext, vfsPath: string): Promise<void> {
  await request.post("/api/fs", { data: { op: "delete", path: vfsPath } });
}

async function clearSelection(request: APIRequestContext, mime: string): Promise<void> {
  await request.post("/api/file-handlers", { data: { mime } });
}

async function openFilesAt(page: Page, folderName: string) {
  await page.getByTestId("dock-files").click();
  const win = page.getByTestId("window-files");
  await expect(win).toBeVisible();
  await win.getByRole("button", { name: "root" }).click();
  await win.locator('[data-testid="files-entry"][data-name="Documents"]').dblclick();
  await win.locator(`[data-testid="files-entry"][data-name="${folderName}"]`).dblclick();
  return win;
}

test.describe("File-type handler registry", () => {
  test("html-viewer is the registered, selected render handler for text/html (US1, US2)", async ({ page }) => {
    const res = await page.request.get("/api/file-handlers?mime=text/html");
    expect(res.ok()).toBeTruthy();
    const view = await res.json();

    expect(view.selected).toBe("html-viewer");
    const webView = view.handlers.find((h: { appId: string }) => h.appId === "html-viewer");
    expect(webView).toBeTruthy();
    expect(webView.capabilities).toContain("render");
    expect(webView.isDefault).toBe(true);
    expect(webView.selected).toBe(true);
    // Its own declared label and its own manifest icon — html-viewer is
    // hidden: true, and a hidden app is still a valid handler (FR-008 / A-6).
    expect(webView.label).toBe("Web View");
    expect(webView.icon).toBe("Code2");
  });

  test("the query normalizes MIME parameters and returns nothing for an unhandled type (US1)", async ({ page }) => {
    // "text/html; charset=utf-8" is exactly what mimeForPath returns, so the
    // parameterized form must resolve to the same handler as the bare one.
    const parameterized = await page.request
      .get(`/api/file-handlers?mime=${encodeURIComponent("text/html; charset=utf-8")}`)
      .then((r) => r.json());
    expect(parameterized.selected).toBe("html-viewer");

    const unhandled = await page.request.get("/api/file-handlers?mime=text/plain").then((r) => r.json());
    expect(unhandled.handlers).toEqual([]);
    expect(unhandled.selected).toBeNull();
  });

  test("double-clicking an .html file opens it in the web_view preview (US3)", async ({ page }) => {
    const folderName = `e2e-handlers-open-${Date.now()}`;
    const dir = `/Documents/${folderName}`;
    await mkdir(page.request, dir);
    await writeFile(page.request, `${dir}/report.html`, "<h1>rendered by web_view</h1>");
    try {
      const win = await openFilesAt(page, folderName);
      await win.locator('[data-testid="files-entry"][data-name="report.html"]').dblclick();

      // A preview WINDOW, not the Files app's raw-source textarea.
      const preview = page.getByTestId("window-html-viewer");
      await expect(preview).toBeVisible();
      const frame = preview.frameLocator("iframe");
      await expect(frame.locator("h1")).toHaveText("rendered by web_view");
    } finally {
      await removeVfsPath(page.request, dir);
    }
  });

  test("a previewed page loads the CSS and JS sitting beside it (US3)", async ({ page }) => {
    // The regression that made "I opened an HTML file and it didn't render"
    // true even though every other part of this feature worked: the handler
    // launched web_view, but the document was served from a QUERY url
    // (/api/fs/raw?path=…), which has no directory for the browser to resolve
    // relative references against — `href="style.css"` became /api/fs/style.css
    // and 404'd. An unstyled page, or a blank one when a relative script builds
    // the body. rawUrlFor now hands over the PATH-shaped url instead.
    const folderName = `e2e-handlers-relative-${Date.now()}`;
    const dir = `/Documents/${folderName}`;
    await mkdir(page.request, dir);
    await writeFile(page.request, `${dir}/style.css`, "h1{color:rgb(0,128,0)}");
    await writeFile(page.request, `${dir}/app.js`, `document.body.insertAdjacentHTML("beforeend","<p id=late>built by app.js</p>")`);
    await writeFile(
      page.request,
      `${dir}/index.html`,
      `<!doctype html><html><head><link rel="stylesheet" href="style.css"></head>` +
        `<body><h1>styled by style.css</h1><script src="app.js"></script></body></html>`,
    );
    try {
      const win = await openFilesAt(page, folderName);
      await win.locator('[data-testid="files-entry"][data-name="index.html"]').dblclick();

      const frame = page.getByTestId("window-html-viewer").frameLocator("iframe");
      // The sibling stylesheet applied…
      await expect(frame.locator("h1")).toHaveCSS("color", "rgb(0, 128, 0)");
      // …and the sibling script ran.
      await expect(frame.locator("#late")).toHaveText("built by app.js");
    } finally {
      await removeVfsPath(page.request, dir);
    }
  });

  test("double-clicking a file of an unhandled type keeps the in-app editor (US3, SC-003)", async ({ page }) => {
    const folderName = `e2e-handlers-fallback-${Date.now()}`;
    const dir = `/Documents/${folderName}`;
    await mkdir(page.request, dir);
    await writeFile(page.request, `${dir}/notes.txt`, "plain text stays in-app");
    try {
      const win = await openFilesAt(page, folderName);
      await win.locator('[data-testid="files-entry"][data-name="notes.txt"]').dblclick();

      await expect(win.locator("textarea")).toHaveValue("plain text stays in-app");
      await expect(page.getByTestId("window-html-viewer")).toHaveCount(0);
    } finally {
      await removeVfsPath(page.request, dir);
    }
  });

  test('right-click shows "Open with" for a handled type and nothing for an unhandled one (US4)', async ({ page }) => {
    const folderName = `e2e-handlers-menu-${Date.now()}`;
    const dir = `/Documents/${folderName}`;
    await mkdir(page.request, dir);
    await writeFile(page.request, `${dir}/page.html`, "<p>hi</p>");
    await writeFile(page.request, `${dir}/notes.txt`, "no handlers here");
    try {
      const win = await openFilesAt(page, folderName);

      await win.locator('[data-testid="files-entry"][data-name="page.html"]').click({ button: "right" });
      const openWith = page.locator('[data-testid="files-open-with"]');
      await expect(openWith).toHaveCount(1);
      await expect(openWith.first()).toHaveText("Open with Web View");
      // It is the selected default, so it carries the checkmark (FR-010).
      await expect(openWith.first().getByTestId("files-open-with-check")).toBeVisible();
      await expect(page.getByTestId("files-context-menu-download")).toBeVisible();

      // A type with no registered handler collapses to the pre-existing menu.
      await win.locator('[data-testid="files-entry"][data-name="notes.txt"]').click({ button: "right" });
      await expect(page.getByTestId("files-context-menu-download")).toBeVisible();
      await expect(page.locator('[data-testid="files-open-with"]')).toHaveCount(0);
    } finally {
      await removeVfsPath(page.request, dir);
    }
  });

  test('a directory shows no "Open with" entries (US4, FR-012)', async ({ page }) => {
    const folderName = `e2e-handlers-dir-${Date.now()}`;
    const dir = `/Documents/${folderName}`;
    await mkdir(page.request, dir);
    await mkdir(page.request, `${dir}/nested`);
    try {
      const win = await openFilesAt(page, folderName);
      await win.locator('[data-testid="files-entry"][data-name="nested"]').click({ button: "right" });

      const download = page.getByTestId("files-context-menu-download");
      await expect(download).toBeVisible();
      await expect(download).toHaveText("Download as zip");
      await expect(page.locator('[data-testid="files-open-with"]')).toHaveCount(0);
    } finally {
      await removeVfsPath(page.request, dir);
    }
  });

  test('picking an "Open with" entry opens the file there (US4)', async ({ page }) => {
    const folderName = `e2e-handlers-pick-${Date.now()}`;
    const dir = `/Documents/${folderName}`;
    await mkdir(page.request, dir);
    await writeFile(page.request, `${dir}/picked.html`, "<h2>opened by pick</h2>");
    try {
      const win = await openFilesAt(page, folderName);
      await win.locator('[data-testid="files-entry"][data-name="picked.html"]').click({ button: "right" });
      await page.locator('[data-testid="files-open-with"][data-app="html-viewer"]').click();

      const preview = page.getByTestId("window-html-viewer");
      await expect(preview).toBeVisible();
      await expect(preview.frameLocator("iframe").locator("h2")).toHaveText("opened by pick");
    } finally {
      await removeVfsPath(page.request, dir);
    }
  });

  test("the selected handler round-trips and an uninstalled app invalidates it (US5)", async ({ page }) => {
    try {
      // "files" declares no text/html handler, so the registry must refuse it
      // and keep the manifest default — a selection has to name a currently
      // installed, render-capable handler (FR-010, FR-011).
      const bogus = await page.request
        .post("/api/file-handlers", { data: { mime: "text/html", appId: "not-an-installed-app" } })
        .then((r) => r.json());
      expect(bogus.selected).toBe("html-viewer");

      // Selecting the real handler is honoured and survives a re-read.
      const set = await page.request
        .post("/api/file-handlers", { data: { mime: "text/html", appId: "html-viewer" } })
        .then((r) => r.json());
      expect(set.selected).toBe("html-viewer");
      const reread = await page.request.get("/api/file-handlers?mime=text/html").then((r) => r.json());
      expect(reread.selected).toBe("html-viewer");

      // Clearing reverts to whichever installed app declares default: true.
      const cleared = await page.request.post("/api/file-handlers", { data: { mime: "text/html" } }).then((r) => r.json());
      expect(cleared.selected).toBe("html-viewer");
    } finally {
      await clearSelection(page.request, "text/html");
    }
  });
});
