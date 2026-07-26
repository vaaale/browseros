import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { APIRequestContext, Page } from "@playwright/test";
import { test, expect } from "./fixtures";

// 037-files-upload-download: drag-and-drop upload into the Files app, and
// right-click "Download" for a single file and for a folder (zipped
// recursively). Each test works inside its own timestamped scratch folder
// under /Documents so runs are isolated from each other and from the
// baseline suite's VFS content, and removes it afterward.

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

async function openFilesAt(page: Page, folderName: string) {
  await page.getByTestId("dock-files").click();
  const win = page.getByTestId("window-files");
  await expect(win).toBeVisible();
  await win.getByRole("button", { name: "root" }).click();
  await win.locator('[data-testid="files-entry"][data-name="Documents"]').dblclick();
  await win.locator(`[data-testid="files-entry"][data-name="${folderName}"]`).dblclick();
  return win;
}

test.describe("Files app — drag & drop upload and right-click download", () => {
  test("dropping a file from the OS uploads it into the open folder", async ({ page }) => {
    const folderName = `e2e-upload-${Date.now()}`;
    const dir = `/Documents/${folderName}`;
    await mkdir(page.request, dir);
    try {
      const win = await openFilesAt(page, folderName);

      const dataTransfer = await page.evaluateHandle(() => {
        const dt = new DataTransfer();
        dt.items.add(new File(["hello from e2e"], "dropped.txt", { type: "text/plain" }));
        return dt;
      });
      await win.getByTestId("files-drop-zone").dispatchEvent("drop", { dataTransfer });

      const uploaded = win.locator('[data-testid="files-entry"][data-name="dropped.txt"]');
      await expect(uploaded).toBeVisible();

      const { entries } = await page.request.get(`/api/fs?op=list&path=${encodeURIComponent(dir)}`).then((r) => r.json());
      expect(entries.map((e: { name: string }) => e.name)).toContain("dropped.txt");
    } finally {
      await removeVfsPath(page.request, dir);
    }
  });

  test("right-click Download on a file downloads its exact contents", async ({ page }) => {
    const folderName = `e2e-download-file-${Date.now()}`;
    const dir = `/Documents/${folderName}`;
    await mkdir(page.request, dir);
    await writeFile(page.request, `${dir}/note.txt`, "download me please");
    try {
      const win = await openFilesAt(page, folderName);
      const entry = win.locator('[data-testid="files-entry"][data-name="note.txt"]');
      await expect(entry).toBeVisible();
      await entry.click({ button: "right" });

      const menu = page.getByTestId("files-context-menu-download");
      await expect(menu).toBeVisible();
      await expect(menu).toHaveText("Download");
      const downloadPromise = page.waitForEvent("download");
      await menu.click();
      const download = await downloadPromise;

      expect(download.suggestedFilename()).toBe("note.txt");
      const savedPath = path.join(os.tmpdir(), `e2e-note-${Date.now()}.txt`);
      await download.saveAs(savedPath);
      expect(fs.readFileSync(savedPath, "utf8")).toBe("download me please");
      fs.rmSync(savedPath, { force: true });
    } finally {
      await removeVfsPath(page.request, dir);
    }
  });

  test("right-click Download on a folder downloads a zip of its contents", async ({ page }) => {
    const folderName = `e2e-download-folder-${Date.now()}`;
    const dir = `/Documents/${folderName}`;
    await mkdir(page.request, dir);
    await mkdir(page.request, `${dir}/nested`);
    await writeFile(page.request, `${dir}/a.txt`, "a-contents");
    await writeFile(page.request, `${dir}/nested/b.txt`, "b-contents");
    try {
      await page.getByTestId("dock-files").click();
      const win = page.getByTestId("window-files");
      await expect(win).toBeVisible();
      await win.getByRole("button", { name: "root" }).click();
      await win.locator('[data-testid="files-entry"][data-name="Documents"]').dblclick();

      const entry = win.locator(`[data-testid="files-entry"][data-name="${folderName}"]`);
      await expect(entry).toBeVisible();
      await entry.click({ button: "right" });

      const menu = page.getByTestId("files-context-menu-download");
      await expect(menu).toBeVisible();
      await expect(menu).toHaveText("Download as zip");
      const downloadPromise = page.waitForEvent("download");
      await menu.click();
      const download = await downloadPromise;

      expect(download.suggestedFilename()).toBe(`${folderName}.zip`);
      const savedPath = path.join(os.tmpdir(), `e2e-folder-${Date.now()}.zip`);
      await download.saveAs(savedPath);

      const listing = execFileSync("unzip", ["-l", savedPath], { encoding: "utf8" });
      expect(listing).toContain("a.txt");
      expect(listing).toContain("nested/b.txt");

      const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-zip-extract-"));
      execFileSync("unzip", ["-o", savedPath, "-d", extractDir]);
      expect(fs.readFileSync(path.join(extractDir, "a.txt"), "utf8")).toBe("a-contents");
      expect(fs.readFileSync(path.join(extractDir, "nested", "b.txt"), "utf8")).toBe("b-contents");

      fs.rmSync(savedPath, { force: true });
      fs.rmSync(extractDir, { recursive: true, force: true });
    } finally {
      await removeVfsPath(page.request, dir);
    }
  });
});
