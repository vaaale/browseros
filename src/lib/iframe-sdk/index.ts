// The BrowserOS iframe SDK (028). Runs INSIDE an installed/marketplace app's
// sandboxed iframe; bundled to /__bos/sdk.js by the route (esbuild, IIFE).
//
// It gives apps a promise-based API over the postMessage broker in
// IframeApp.tsx. Only capabilities granted in the app's manifest are honoured by
// the parent; ungranted calls reject. This module is the SINGLE channel an
// opaque-origin app has to BOS (028 sandbox), so it is deliberately small and
// dependency-free. NOT server-only — it is browser code.

interface BosResponse {
  __bos_response?: true;
  seq: number;
  result?: unknown;
  error?: string;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

interface BosApi {
  fs: {
    list: (path: string) => Promise<unknown>;
    read: (path: string) => Promise<unknown>;
    write: (path: string, content: string) => Promise<unknown>;
    delete: (path: string) => Promise<unknown>;
  };
  settings: { get: () => Promise<unknown> };
  window: { setTitle: (title: string) => Promise<unknown> };
  notify: (message: string, opts?: Record<string, unknown>) => Promise<unknown>;
  /** Per-app persistent key/value store (requires the "storage" capability).
   *  Also backs the localStorage/sessionStorage shim. */
  storage: {
    get: (key: string) => Promise<string | null>;
    set: (key: string, value: string) => Promise<unknown>;
    remove: (key: string) => Promise<unknown>;
    keys: () => Promise<string[]>;
  };
}

type BosWindow = Window & { __bos?: BosApi };

(function install(): void {
  const w = window as BosWindow;
  if (w.__bos) return;

  let seq = 0;
  const pending = new Map<number, Pending>();

  window.addEventListener("message", (e: MessageEvent) => {
    const d = e.data as BosResponse | null;
    if (!d || d.__bos_response == null) return;
    const p = pending.get(d.seq);
    if (!p) return;
    pending.delete(d.seq);
    if (d.error) p.reject(new Error(d.error));
    else p.resolve(d.result);
  });

  function call(method: string, params: Record<string, unknown>): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const s = ++seq;
      pending.set(s, { resolve, reject });
      window.parent.postMessage({ __bos_call: true, seq: s, method, params }, "*");
    });
  }

  w.__bos = {
    fs: {
      list: (path) => call("fs:list", { path }),
      read: (path) => call("fs:read", { path }),
      write: (path, content) => call("fs:write", { path, content }),
      delete: (path) => call("fs:delete", { path }),
    },
    settings: { get: () => call("settings:get", {}) },
    window: { setTitle: (title) => call("window:title", { title }) },
    notify: (message, opts) => call("notify", { message, ...(opts ?? {}) }),
    storage: {
      get: (key) => call("storage:get", { key }) as Promise<string | null>,
      set: (key, value) => call("storage:set", { key, value }),
      remove: (key) => call("storage:remove", { key }),
      keys: () => call("storage:keys", {}) as Promise<string[]>,
    },
  };

  // localStorage/sessionStorage shim (028). An opaque-origin app has no browser
  // storage, so back it with the per-app `storage` capability. localStorage is
  // hydrated SYNCHRONOUSLY from the snapshot the app-serving route inlined
  // (window.__bos_storage_snapshot) so a startup read never returns a cold null;
  // writes are write-through (best-effort — a no-op if `storage` isn't granted).
  // sessionStorage is in-memory only (ephemeral by spec). IndexedDB is not shimmed.
  const snapshot =
    (w as unknown as { __bos_storage_snapshot?: Record<string, string> }).__bos_storage_snapshot ?? {};

  const makeStorage = (
    backing: Map<string, string>,
    persist: { set: (k: string, v: string) => void; remove: (k: string) => void } | null,
  ): Storage =>
    ({
      getItem: (k: string): string | null => (backing.has(k) ? (backing.get(k) as string) : null),
      setItem: (k: string, v: string): void => {
        const val = String(v);
        backing.set(k, val);
        persist?.set(k, val);
      },
      removeItem: (k: string): void => {
        backing.delete(k);
        persist?.remove(k);
      },
      clear: (): void => {
        for (const k of Array.from(backing.keys())) persist?.remove(k);
        backing.clear();
      },
      key: (i: number): string | null => Array.from(backing.keys())[i] ?? null,
      get length(): number {
        return backing.size;
      },
    }) as unknown as Storage;

  // Only shim when native storage is UNAVAILABLE (opaque-origin apps throw on
  // access). Same-origin apps keep their real browser storage untouched — the
  // shim must never silently move a working app's data into BOS.
  function nativeStorageWorks(): boolean {
    try {
      const probe = "__bos_probe__";
      window.localStorage.setItem(probe, "1");
      window.localStorage.removeItem(probe);
      return true;
    } catch {
      return false;
    }
  }

  if (!nativeStorageWorks()) {
    try {
      const local = new Map<string, string>(Object.entries(snapshot));
      Object.defineProperty(window, "localStorage", {
        configurable: true,
        value: makeStorage(local, {
          set: (k, v) => void (w.__bos as BosApi).storage.set(k, v).catch(() => {}),
          remove: (k) => void (w.__bos as BosApi).storage.remove(k).catch(() => {}),
        }),
      });
      Object.defineProperty(window, "sessionStorage", {
        configurable: true,
        value: makeStorage(new Map<string, string>(), null),
      });
    } catch {
      // Browser refused the override — nothing more we can do.
    }
  }

  window.dispatchEvent(new Event("bos:ready"));
})();
