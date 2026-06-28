# Files

The **Files** app is a browser for your **virtual file system (VFS)** — your
personal, sandboxed storage inside BOS. It starts with `Documents`, `Pictures`,
and `Desktop` folders.

> **This is your data, not BOS's program files.** The VFS is completely separate
> from BrowserOS's own source code. The assistant's file tools and this app can
> only ever see your files here — never the OS internals.

---

## Navigating

- **Open a folder** — double‑click it.
- **Go up** — the up arrow in the toolbar.
- **Breadcrumbs** — click any segment of the path (starting at **root**) to jump
  there.
- **Refresh** — re‑read the current folder.

Folders, text files, and images each show a distinct icon.

---

## Creating, renaming, deleting

- **New folder** / **New file** — the toolbar buttons (you'll be prompted for a
  name; new files start empty).
- **Rename** — hover an item and click the pencil.
- **Delete** — hover an item and click the trash icon (you'll be asked to confirm).

---

## Viewing and editing files

Double‑click a file to open it:

- **Text files** open in a simple editor. Edit the content and click **Save**
  (the button enables once you've made a change).
- **Images** (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.svg`) are shown as a
  preview. From the preview you can choose **Set as wallpaper** to use the image
  as your desktop background.

Close the viewer with the **✕** button to return to the folder.

---

## What lives in your files

Besides anything you create, some BOS features store data in your VFS so it's
visible and portable:

- **Chat history** — each conversation is a JSON file under
  `Documents/Chats/`.
- **Workflows** — saved under `Workflows/` (used by the Workflow Manager app).

You can inspect these like any other file, but it's usually easier to manage them
from the **Assistant** and **Workflow Manager** apps.

---

## The assistant and your files

The assistant can list, read, write, create, and delete files here on your behalf
(for example, "save these notes to Documents/notes.md"). It confirms destructive
operations. Everything it does is confined to this sandbox.
