"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
} from "lucide-react";
import type { VfsEntry } from "@/os/types";
import { fsClient } from "@/lib/os-client";
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
  const dragDepth = useRef(0);

  const setTitle = useOSStore((s) => s.setTitle);
  const applySettings = useOSStore((s) => s.applySettings);

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

  const openEntry = async (entry: VfsEntry) => {
    if (entry.type === "dir") {
      setCwd(entry.path);
      return;
    }
    setOpen(entry);
    if (IMAGE_RE.test(entry.name)) return;
    try {
      setText(await fsClient.read(entry.path));
      setDirty(false);
    } catch (e) {
      setText(`Could not read file: ${(e as Error).message}`);
    }
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
        <div
          style={{ position: "fixed", left: menu.x, top: menu.y, zIndex: 100002 }}
          className="min-w-[140px] rounded border border-white/15 bg-neutral-900 py-1 text-xs shadow-2xl"
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
          data-testid="files-context-menu"
        >
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
        </div>
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
