"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowUp,
  RefreshCw,
  FolderPlus,
  FilePlus,
  Trash2,
  Pencil,
  Folder,
  FileText,
  Image as ImageIcon,
  Save,
  X,
  ImagePlus,
  Download,
  UploadCloud,
  Check,
} from "lucide-react";
import type { VfsEntry } from "@/os/types";
import { fsClient, fileHandlersClient } from "@/lib/os-client";
import { buildLaunchParams, fileBaseMime, type FileHandlerView } from "@/os/file-handlers";
import { AppIcon } from "@/components/desktop/icons";
import { useOSStore } from "@/store/os-provider";
import type { AppProps } from "@/components/apps/types";

const IMAGE_RE = /\.(png|jpe?g|gif|webp|svg)$/i;

function parentOf(p: string): string {
  if (p === "/" || p === "") return "/";
  const parts = p.split("/").filter(Boolean);
  parts.pop();
  return "/" + parts.join("/");
}

export default function FileBrowser({ windowId, params }: AppProps) {
  const startPath = typeof params?.path === "string" ? (params.path as string) : "/";
  const [cwd, setCwd] = useState(startPath);
  const [entries, setEntries] = useState<VfsEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState<VfsEntry | null>(null);
  const [text, setText] = useState("");
  const [dirty, setDirty] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [upload, setUpload] = useState<{ loaded: number; total: number } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; entry: VfsEntry } | null>(null);
  // Handlers for the file the context menu is open on. Fetched when the menu
  // opens rather than per entry: the list only matters once a menu is showing,
  // and an empty list must render the menu exactly as it did before 036.
  const [handlers, setHandlers] = useState<FileHandlerView[]>([]);
  const dragDepth = useRef(0);
  // Bumped on every menu open so a slow lookup for one file can never paint its
  // handlers over a menu the user has since opened on a different file.
  const handlerReq = useRef(0);

  const setTitle = useOSStore((s) => s.setTitle);
  const applySettings = useOSStore((s) => s.applySettings);
  const launch = useOSStore((s) => s.launch);

  const refresh = useCallback(async (path: string) => {
    setLoading(true);
    setError(null);
    try {
      setEntries(await fsClient.list(path));
    } catch (e) {
      setError((e as Error).message);
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const id = setTimeout(() => {
      void refresh(cwd);
      setTitle(windowId, `Files — ${cwd}`);
    }, 0);
    return () => clearTimeout(id);
  }, [cwd, refresh, setTitle, windowId]);

  // Close the right-click menu on any outside click, a fresh right-click, scroll, or Escape.
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("click", close);
    document.addEventListener("contextmenu", close);
    document.addEventListener("scroll", close, true);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("click", close);
      document.removeEventListener("contextmenu", close);
      document.removeEventListener("scroll", close, true);
      document.removeEventListener("keydown", onEsc);
    };
  }, [menu]);

  const openMenu = (e: React.MouseEvent, entry: VfsEntry) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, entry });
    // Cleared first so a slow lookup can never show the previous file's
    // handlers. Directories have none by definition (FR-012).
    setHandlers([]);
    if (entry.type !== "file") return;
    const req = ++handlerReq.current;
    void fileHandlersClient
      .list(fileBaseMime(entry.path))
      .then((view) => {
        if (handlerReq.current === req) setHandlers(view.handlers);
      })
      .catch(() => {});
  };

  const uploadFiles = async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (list.length === 0) return;
    const total = list.reduce((sum, f) => sum + f.size, 0);
    setUpload({ loaded: 0, total });
    setError(null);
    try {
      await fsClient.upload(cwd, list, (loaded, t) => setUpload({ loaded, total: t }));
      await refresh(cwd);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUpload(null);
    }
  };

  const onDragOver = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  };
  const onDragEnter = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    dragDepth.current += 1;
    setDragActive(true);
  };
  const onDragLeave = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragActive(false);
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    dragDepth.current = 0;
    setDragActive(false);
    void uploadFiles(e.dataTransfer.files);
  };

  // The Files app's own viewer/editor — the behavior that predates 036 and
  // still handles every type no installed app has claimed (FR-007, SC-003).
  const openInApp = async (entry: VfsEntry) => {
    setOpen(entry);
    if (IMAGE_RE.test(entry.name)) return;
    try {
      setText(await fsClient.read(entry.path));
      setDirty(false);
    } catch (e) {
      setText(`Could not read file: ${(e as Error).message}`);
    }
  };

  /** Hand a file to a registered handler via the open-file launch contract.
   *  Returns false if the app turned out not to be launchable, so the caller
   *  can fall back rather than leave the user staring at nothing (R-3). */
  const launchHandler = (handler: FileHandlerView, entry: VfsEntry, action: "open" | "edit"): boolean =>
    launch(handler.appId, buildLaunchParams(handler.decl, entry.path, action)) !== null;

  /** An "Open with <App>" pick. A render-capable choice is also an "always open
   *  with" — it becomes the type's selected handler, so double-click follows it
   *  from now on. An edit-only one is a one-shot: a selection must be
   *  render-capable (FR-010 / ADR-6), so the checkmark stays put. */
  const pickHandler = (handler: FileHandlerView, entry: VfsEntry) => {
    const renders = handler.capabilities.includes("render");
    setMenu(null);
    if (!launchHandler(handler, entry, renders ? "open" : "edit")) {
      void openInApp(entry);
      return;
    }
    // Fire-and-forget: the file is already open; persisting the preference is
    // not something the user should wait on.
    if (renders) void fileHandlersClient.setSelected(fileBaseMime(entry.path), handler.appId).catch(() => {});
  };

  const openEntry = async (entry: VfsEntry) => {
    if (entry.type === "dir") {
      setCwd(entry.path);
      return;
    }
    // Ask the registry who owns this type. A render-capable selection wins;
    // anything else — no handler, an expired selection, an app that failed to
    // launch — falls through to the in-app path unchanged.
    try {
      const view = await fileHandlersClient.list(fileBaseMime(entry.path));
      const selected = view.handlers.find((h) => h.appId === view.selected);
      if (selected && launchHandler(selected, entry, "open")) return;
    } catch {
      // Registry unreachable — opening the file still has to work.
    }
    await openInApp(entry);
  };

  const newFolder = async () => {
    const name = window.prompt("New folder name");
    if (!name) return;
    try {
      await fsClient.mkdir(`${cwd === "/" ? "" : cwd}/${name}`);
      refresh(cwd);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const newFile = async () => {
    const name = window.prompt("New file name", "untitled.txt");
    if (!name) return;
    try {
      await fsClient.write(`${cwd === "/" ? "" : cwd}/${name}`, "");
      refresh(cwd);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const removeEntry = async (entry: VfsEntry) => {
    if (!window.confirm(`Delete ${entry.name}?`)) return;
    try {
      await fsClient.remove(entry.path);
      refresh(cwd);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const renameEntry = async (entry: VfsEntry) => {
    const name = window.prompt("Rename to", entry.name);
    if (!name || name === entry.name) return;
    try {
      await fsClient.rename(entry.path, `${parentOf(entry.path) === "/" ? "" : parentOf(entry.path)}/${name}`);
      refresh(cwd);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const saveText = async () => {
    if (!open) return;
    try {
      await fsClient.write(open.path, text);
      setDirty(false);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const setAsWallpaper = async (entry: VfsEntry) => {
    applySettings({ wallpaper: entry.path });
    const { settingsClient } = await import("@/lib/os-client");
    await settingsClient.patch({ wallpaper: entry.path });
  };

  const crumbs = ["/", ...cwd.split("/").filter(Boolean)];

  return (
    <div className="flex h-full flex-col text-sm">
      <div className="flex items-center gap-1 border-b border-white/10 bg-white/5 px-2 py-1.5">
        <button onClick={() => setCwd(parentOf(cwd))} disabled={cwd === "/"} title="Up" className="rounded p-1.5 hover:bg-white/10 disabled:opacity-30">
          <ArrowUp size={16} />
        </button>
        <button onClick={() => refresh(cwd)} title="Refresh" className="rounded p-1.5 hover:bg-white/10">
          <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
        </button>
        <div className="mx-1 flex flex-1 items-center gap-1 overflow-x-auto whitespace-nowrap text-xs text-white/60">
          {crumbs.map((c, i) => {
            const path = i === 0 ? "/" : "/" + crumbs.slice(1, i + 1).join("/");
            return (
              <span key={path} className="flex items-center gap-1">
                {i > 0 && <span className="text-white/30">/</span>}
                <button onClick={() => setCwd(path)} className="rounded px-1 hover:bg-white/10 hover:text-white">
                  {i === 0 ? "root" : c}
                </button>
              </span>
            );
          })}
        </div>
        <button onClick={newFolder} title="New folder" className="rounded p-1.5 hover:bg-white/10"><FolderPlus size={16} /></button>
        <button onClick={newFile} title="New file" className="rounded p-1.5 hover:bg-white/10"><FilePlus size={16} /></button>
      </div>

      {error && <div className="bg-red-500/20 px-3 py-1 text-xs text-red-200">{error}</div>}

      {upload && (
        <div className="flex items-center gap-2 bg-sky-500/20 px-3 py-1 text-xs text-sky-100" data-testid="files-upload-progress">
          <UploadCloud size={14} className="animate-pulse" />
          Uploading… {upload.total > 0 ? Math.round((upload.loaded / upload.total) * 100) : 0}%
        </div>
      )}

      <div
        className="relative min-h-0 flex-1"
        data-testid="files-drop-zone"
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        <div className="grid h-full auto-rows-min grid-cols-[repeat(auto-fill,minmax(96px,1fr))] gap-1 overflow-auto p-3">
          {entries.map((entry) => (
            <div
              key={entry.path}
              onDoubleClick={() => openEntry(entry)}
              onContextMenu={(e) => openMenu(e, entry)}
              className="group relative flex cursor-default flex-col items-center gap-1 rounded-lg p-2 hover:bg-white/10"
              title={entry.name}
              data-testid="files-entry"
              data-name={entry.name}
            >
              {entry.type === "dir" ? (
                <Folder size={36} className="text-sky-300" />
              ) : IMAGE_RE.test(entry.name) ? (
                <ImageIcon size={36} className="text-emerald-300" />
              ) : (
                <FileText size={36} className="text-white/70" />
              )}
              <span className="line-clamp-2 max-w-full break-words text-center text-[11px] text-white/80">{entry.name}</span>
              <div className="absolute right-0 top-0 hidden gap-0.5 rounded bg-black/60 p-0.5 group-hover:flex">
                <button onClick={() => renameEntry(entry)} title="Rename" className="rounded p-1 hover:bg-white/20"><Pencil size={12} /></button>
                <button onClick={() => removeEntry(entry)} title="Delete" className="rounded p-1 hover:bg-white/20"><Trash2 size={12} /></button>
              </div>
            </div>
          ))}
          {!loading && entries.length === 0 && (
            <div className="col-span-full py-10 text-center text-xs text-white/40">This folder is empty</div>
          )}
        </div>

        {dragActive && (
          <div
            className="pointer-events-none absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 border-2 border-dashed border-sky-400 bg-sky-500/10 text-sky-100"
            data-testid="files-drop-overlay"
          >
            <UploadCloud size={32} />
            <span className="text-xs">Drop files to upload to {cwd}</span>
          </div>
        )}
      </div>

      {menu && (
        <CursorMenu x={menu.x} y={menu.y} contentKey={handlers.length}>
          {handlers.length > 0 && (
            <>
              <div className="px-3 pb-0.5 pt-1 text-[10px] font-semibold uppercase tracking-wide text-white/40">
                Open with
              </div>
              {handlers.map((handler) => (
                <button
                  key={handler.appId}
                  type="button"
                  onClick={() => pickHandler(handler, menu.entry)}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-white/80 hover:bg-white/10"
                  data-testid="files-open-with"
                  data-app={handler.appId}
                >
                  {/* The TARGET app's own manifest icon — a hidden handler like
                      html-viewer has no dock icon but still shows its glyph. */}
                  <AppIcon name={handler.icon} size={14} className="shrink-0" />
                  <span className="flex-1">Open with {handler.label}</span>
                  {handler.selected ? (
                    <Check size={14} className="shrink-0 text-white/70" data-testid="files-open-with-check" />
                  ) : (
                    <span className="w-[14px] shrink-0" />
                  )}
                </button>
              ))}
              <div className="mx-2 my-1 h-px bg-white/10" />
            </>
          )}
          <button
            type="button"
            onClick={() => {
              fsClient.downloadEntry(menu.entry.path);
              setMenu(null);
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-white/80 hover:bg-white/10"
            data-testid="files-context-menu-download"
          >
            <Download size={14} />
            {menu.entry.type === "dir" ? "Download as zip" : "Download"}
          </button>
        </CursorMenu>
      )}

      {open && (
        <div className="absolute inset-0 z-10 flex flex-col bg-[#0f1117]">
          <div className="flex items-center gap-2 border-b border-white/10 bg-white/5 px-3 py-1.5">
            <button onClick={() => setOpen(null)} className="rounded p-1.5 hover:bg-white/10"><X size={16} /></button>
            <span className="flex-1 truncate text-xs text-white/70">{open.path}</span>
            {IMAGE_RE.test(open.name) ? (
              <button onClick={() => setAsWallpaper(open)} className="flex items-center gap-1 rounded bg-white/10 px-2 py-1 text-xs hover:bg-white/20">
                <ImagePlus size={14} /> Set as wallpaper
              </button>
            ) : (
              <button onClick={saveText} disabled={!dirty} className="flex items-center gap-1 rounded bg-white/10 px-2 py-1 text-xs hover:bg-white/20 disabled:opacity-40">
                <Save size={14} /> Save
              </button>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {IMAGE_RE.test(open.name) ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={fsClient.rawUrl(open.path)} alt={open.name} className="mx-auto max-h-full max-w-full object-contain p-3" />
            ) : (
              <textarea
                value={text}
                onChange={(e) => { setText(e.target.value); setDirty(true); }}
                spellCheck={false}
                className="h-full w-full resize-none bg-transparent p-3 font-mono text-xs text-white/90 outline-none"
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// Distance kept between the menu and the viewport edge when it has to be
// nudged back on-screen.
const MENU_MARGIN = 4;

// The right-click menu, portalled to document.body. Window chrome is
// CSS-transform-positioned (Window.tsx), which makes the window the containing
// block for every `position: fixed` descendant — rendered inline, the menu's
// left/top resolved against the window box while `clientX`/`clientY` are
// viewport coordinates, so the menu appeared offset by wherever the window sat
// (style-guide.md § Modal / dialog). Portalling puts both back in the same
// coordinate space, i.e. under the cursor.
function CursorMenu({
  x,
  y,
  contentKey,
  children,
}: {
  x: number;
  y: number;
  // Bumped whenever the menu's contents change size — the async handler lookup
  // lands after the first paint, so the clamp below has to re-measure.
  contentKey: number;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ x, y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPos({
      x: Math.max(MENU_MARGIN, Math.min(x, window.innerWidth - width - MENU_MARGIN)),
      y: Math.max(MENU_MARGIN, Math.min(y, window.innerHeight - height - MENU_MARGIN)),
    });
  }, [x, y, contentKey]);

  return createPortal(
    <div
      ref={ref}
      style={{ position: "fixed", left: pos.x, top: pos.y, zIndex: 100002 }}
      className="min-w-[140px] rounded border border-white/15 bg-neutral-900 py-1 text-xs shadow-2xl"
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
      data-testid="files-context-menu"
    >
      {children}
    </div>,
    document.body,
  );
}
