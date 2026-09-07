"use client";

import type { OSSettings, VfsEntry } from "@/os/types";
import type { FileHandlerListing } from "@/os/file-handlers";
import { sessionHeader } from "@/lib/logging/client/session";

// Must match FEATURE_CONVERSATION_HEADER in @/lib/specs/feature-context (a
// server-only module, so the client can't import the constant directly).
const CONVERSATION_HEADER = "x-bos-conversation";

async function jsonOrThrow<T>(res: Response): Promise<T> {
  const data = await res.json();
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Request failed (${res.status})`);
  return data as T;
}

function fsOps(extraHeaders: Record<string, string>) {
  const headers = { "Content-Type": "application/json", ...sessionHeader(), ...extraHeaders };
  return {
    list: (path: string) =>
      fetch(`/api/fs?op=list&path=${encodeURIComponent(path)}`, { headers: extraHeaders }).then((r) =>
        jsonOrThrow<{ entries: VfsEntry[] }>(r).then((d) => d.entries),
      ),
    read: (path: string) =>
      fetch(`/api/fs?op=read&path=${encodeURIComponent(path)}`, { headers: extraHeaders }).then((r) =>
        jsonOrThrow<{ content: string }>(r).then((d) => d.content),
      ),
    write: (path: string, content: string) =>
      fetch("/api/fs", { method: "POST", headers, body: JSON.stringify({ op: "write", path, content }) }).then((r) =>
        jsonOrThrow<{ ok: true }>(r),
      ),
    mkdir: (path: string) =>
      fetch("/api/fs", { method: "POST", headers, body: JSON.stringify({ op: "mkdir", path }) }).then((r) =>
        jsonOrThrow<{ ok: true }>(r),
      ),
    remove: (path: string) =>
      fetch("/api/fs", { method: "POST", headers, body: JSON.stringify({ op: "delete", path }) }).then((r) =>
        jsonOrThrow<{ ok: true }>(r),
      ),
    rename: (path: string, to: string) =>
      fetch("/api/fs", { method: "POST", headers, body: JSON.stringify({ op: "rename", path, to }) }).then((r) =>
        jsonOrThrow<{ ok: true }>(r),
      ),
  };
}

export const fsClient = {
  ...fsOps({}),
  /** A conversation-scoped client: carries the active conversation id so a
   *  write under a branch-coupled mount (/Specs, /Docs) resolves the
   *  conversation's active feature branch server-side. Use this from agent
   *  tool handlers (FrontendToolsV2) instead of the bare fsClient. */
  scoped: (conversationId: string) => ({
    ...fsClient,
    ...fsOps({ [CONVERSATION_HEADER]: conversationId }),
  }),
  // `conversationId` is optional and travels as a query param, not a header —
  // both routes are loaded via plain browser navigation (iframe src / anchor
  // download), which cannot set custom headers the way scoped() above does
  // for its fetch()-based ops. Without it, a path under a branch-coupled
  // mount (/Specs, /Docs) that only exists on an active feature branch
  // silently 404s even though it's genuinely reachable through file_read.
  rawUrl: (path: string, conversationId?: string) =>
    `/api/fs/raw?path=${encodeURIComponent(path)}${conversationId ? `&conversationId=${encodeURIComponent(conversationId)}` : ""}`,
  downloadUrl: (path: string, conversationId?: string) =>
    `/api/fs/download?path=${encodeURIComponent(path)}${conversationId ? `&conversationId=${encodeURIComponent(conversationId)}` : ""}`,
  /** Trigger a browser download of a file or a zipped folder without navigating away. */
  downloadEntry: (path: string) => {
    const a = document.createElement("a");
    a.href = fsClient.downloadUrl(path);
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  },
  /** Upload one or more OS files into a VFS directory, reporting byte progress via XHR (fetch has no upload progress event). */
  upload: (dirPath: string, files: File[] | FileList, onProgress?: (loaded: number, total: number) => void) =>
    new Promise<{ ok: true; uploaded: string[] }>((resolve, reject) => {
      const body = new FormData();
      body.append("path", dirPath);
      Array.from(files).forEach((f) => body.append("files", f));
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/fs/upload");
      for (const [k, v] of Object.entries(sessionHeader())) xhr.setRequestHeader(k, v);
      xhr.upload.onprogress = (e) => {
        if (onProgress && e.lengthComputable) onProgress(e.loaded, e.total);
      };
      xhr.onload = () => {
        let data: { ok?: true; uploaded?: string[]; error?: string } = {};
        try {
          data = JSON.parse(xhr.responseText);
        } catch {
          reject(new Error(`Upload failed (${xhr.status})`));
          return;
        }
        if (xhr.status >= 200 && xhr.status < 300 && data.ok) {
          resolve({ ok: true, uploaded: data.uploaded ?? [] });
        } else {
          reject(new Error(data.error ?? `Upload failed (${xhr.status})`));
        }
      };
      xhr.onerror = () => reject(new Error("Upload failed"));
      xhr.send(body);
    }),
};

/** 036-file-type-handlers: the client's view of the handler registry. `list` is
 *  what the Files app calls on double-click and on opening a context menu;
 *  `setSelected` records an "always open with" pick. */
export const fileHandlersClient = {
  list: (mime: string) =>
    fetch(`/api/file-handlers?mime=${encodeURIComponent(mime)}`).then((r) =>
      jsonOrThrow<FileHandlerListing>(r),
    ),
  setSelected: (mime: string, appId?: string) =>
    fetch("/api/file-handlers", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...sessionHeader() },
      body: JSON.stringify({ mime, appId }),
    }).then((r) => jsonOrThrow<FileHandlerListing>(r)),
};

export const settingsClient = {
  patch: (patch: Partial<OSSettings>) =>
    fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...sessionHeader() },
      body: JSON.stringify(patch),
    }).then((r) => jsonOrThrow<{ settings: OSSettings }>(r).then((d) => d.settings)),
};
