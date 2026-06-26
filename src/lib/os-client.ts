"use client";

import type { OSSettings, VfsEntry } from "@/os/types";

async function jsonOrThrow<T>(res: Response): Promise<T> {
  const data = await res.json();
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Request failed (${res.status})`);
  return data as T;
}

export const fsClient = {
  list: (path: string) =>
    fetch(`/api/fs?op=list&path=${encodeURIComponent(path)}`).then((r) =>
      jsonOrThrow<{ entries: VfsEntry[] }>(r).then((d) => d.entries),
    ),
  read: (path: string) =>
    fetch(`/api/fs?op=read&path=${encodeURIComponent(path)}`).then((r) =>
      jsonOrThrow<{ content: string }>(r).then((d) => d.content),
    ),
  write: (path: string, content: string) =>
    fetch("/api/fs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op: "write", path, content }),
    }).then((r) => jsonOrThrow<{ ok: true }>(r)),
  mkdir: (path: string) =>
    fetch("/api/fs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op: "mkdir", path }),
    }).then((r) => jsonOrThrow<{ ok: true }>(r)),
  remove: (path: string) =>
    fetch("/api/fs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op: "delete", path }),
    }).then((r) => jsonOrThrow<{ ok: true }>(r)),
  rename: (path: string, to: string) =>
    fetch("/api/fs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op: "rename", path, to }),
    }).then((r) => jsonOrThrow<{ ok: true }>(r)),
  rawUrl: (path: string) => `/api/fs/raw?path=${encodeURIComponent(path)}`,
};

export const settingsClient = {
  patch: (patch: Partial<OSSettings>) =>
    fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }).then((r) => jsonOrThrow<{ settings: OSSettings }>(r).then((d) => d.settings)),
};
