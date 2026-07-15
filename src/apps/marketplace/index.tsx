"use client";

import { useCallback, useEffect, useState } from "react";

// Marketplace app (028): browse registered marketplaces and their items, add a
// marketplace by git URL, sync/remove, and ADOPT a spec (fork into the user spec
// store). App install/run is a follow-on increment; app items are shown as such.

interface Item {
  id: string;
  name: string;
  description: string;
  tags?: string[];
  app?: { version: string; icon?: string };
  spec?: { version: string };
}

interface Catalog {
  id: string;
  name: string;
  url: string;
  lastSynced: string | null;
  items: Item[];
  error?: string;
}

const API = "/api/marketplace";

export default function MarketplaceApp() {
  const [catalog, setCatalog] = useState<Catalog[]>([]);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const r = await fetch(API);
    const d = (await r.json()) as { marketplaces?: Catalog[] };
    setCatalog(d.marketplaces ?? []);
  }, []);

  // Initial load — set state only from the async callback (not synchronously).
  useEffect(() => {
    let alive = true;
    fetch(API)
      .then((r) => r.json())
      .then((d: { marketplaces?: Catalog[] }) => {
        if (alive) setCatalog(d.marketplaces ?? []);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const op = useCallback(
    async (body: Record<string, unknown>, onOk?: (d: Record<string, unknown>) => void) => {
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        const r = await fetch(API, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const d = (await r.json()) as Record<string, unknown>;
        if (!r.ok) throw new Error((d.error as string) || "Request failed");
        await refresh();
        onOk?.(d);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  return (
    <div className="flex h-full flex-col bg-neutral-950 text-neutral-100">
      {/* Add a marketplace */}
      <div className="flex items-center gap-2 border-b border-white/10 p-3">
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="Add marketplace by git URL (https://… )"
          className="flex-1 rounded-md bg-white/5 px-3 py-1.5 text-sm outline-none placeholder:text-white/30 focus:bg-white/10"
          onKeyDown={(e) => {
            if (e.key === "Enter" && url.trim()) void op({ op: "add", url: url.trim() }, () => setUrl(""));
          }}
        />
        <button
          disabled={busy || !url.trim()}
          onClick={() => void op({ op: "add", url: url.trim() }, () => setUrl(""))}
          className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium disabled:opacity-40"
        >
          Add
        </button>
      </div>

      {error && <div className="border-b border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">{error}</div>}
      {notice && <div className="border-b border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">{notice}</div>}

      <div className="flex-1 overflow-auto p-3">
        {catalog.length === 0 && (
          <div className="mt-10 text-center text-sm text-white/40">
            No marketplaces yet. Add one by its git URL above.
          </div>
        )}

        {catalog.map((mk) => (
          <section key={mk.id} className="mb-5 rounded-lg border border-white/10">
            <header className="flex items-center justify-between px-3 py-2">
              <div>
                <div className="text-sm font-semibold">{mk.name}</div>
                <div className="text-xs text-white/40">{mk.url}</div>
              </div>
              <div className="flex gap-2">
                <button
                  disabled={busy}
                  onClick={() => void op({ op: "sync", id: mk.id }, () => setNotice(`Synced ${mk.name}`))}
                  className="rounded bg-white/10 px-2 py-1 text-xs hover:bg-white/20 disabled:opacity-40"
                >
                  Sync
                </button>
                <button
                  disabled={busy}
                  onClick={() => void op({ op: "remove", id: mk.id })}
                  className="rounded bg-white/10 px-2 py-1 text-xs hover:bg-red-500/30 disabled:opacity-40"
                >
                  Remove
                </button>
              </div>
            </header>

            {mk.error && <div className="px-3 pb-2 text-xs text-red-300">Manifest error: {mk.error}</div>}

            <div className="grid grid-cols-1 gap-2 p-3 sm:grid-cols-2">
              {mk.items.map((item) => (
                <div key={item.id} className="rounded-md border border-white/10 bg-white/5 p-3">
                  <div className="flex items-center justify-between">
                    <div className="text-sm font-medium">{item.name}</div>
                    <div className="flex gap-1">
                      {item.spec && <span className="rounded bg-purple-500/20 px-1.5 py-0.5 text-[10px] text-purple-300">spec</span>}
                      {item.app && <span className="rounded bg-sky-500/20 px-1.5 py-0.5 text-[10px] text-sky-300">app</span>}
                    </div>
                  </div>
                  <div className="mt-1 line-clamp-2 text-xs text-white/50">{item.description}</div>
                  <div className="mt-3 flex gap-2">
                    {item.spec && (
                      <button
                        disabled={busy}
                        onClick={() =>
                          void op({ op: "adopt-spec", id: mk.id, itemId: item.id }, (d) => {
                            const adopted = d.adopted as { storePath?: string } | undefined;
                            setNotice(`Adopted into ${adopted?.storePath ?? "your specs"} — open Build Studio to edit.`);
                          })
                        }
                        className="rounded bg-purple-600 px-2 py-1 text-xs font-medium hover:bg-purple-500 disabled:opacity-40"
                      >
                        Adopt spec
                      </button>
                    )}
                    {item.app && (
                      <button
                        disabled={busy}
                        onClick={() =>
                          void op({ op: "install-app", id: mk.id, itemId: item.id }, (d) => {
                            const installed = d.installed as { name?: string } | undefined;
                            setNotice(`Installed "${installed?.name ?? item.name}" — find it on your desktop.`);
                          })
                        }
                        className="rounded bg-sky-600 px-2 py-1 text-xs font-medium hover:bg-sky-500 disabled:opacity-40"
                      >
                        Install app
                      </button>
                    )}
                  </div>
                </div>
              ))}
              {mk.items.length === 0 && !mk.error && <div className="text-xs text-white/40">No items.</div>}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
