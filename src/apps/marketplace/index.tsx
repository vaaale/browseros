"use client";

import { useCallback, useEffect, useState } from "react";
import { useOSStore } from "@/store/os-provider";
import type { AppManifest } from "@/os/types";

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
  skill?: { version: string };
  services?: { version: string };
}

/** The local user-apps/ "marketplace" — always present, not a real registration. */
const LOCAL_MARKETPLACE_ID = "user-apps";

interface Catalog {
  id: string;
  name: string;
  url: string;
  lastSynced: string | null;
  items: Item[];
  error?: string;
}

const API = "/api/marketplace";
const SKILLS_API = "/api/skills";
const SERVICES_API = "/api/services";

async function fetchSkillIds(): Promise<Set<string>> {
  try {
    const r = await fetch(SKILLS_API);
    if (!r.ok) return new Set();
    const d = (await r.json()) as { skills?: Array<{ id: string }> };
    return new Set((d.skills ?? []).map((s) => s.id));
  } catch {
    return new Set();
  }
}

async function fetchInstalledServiceIds(): Promise<Set<string>> {
  try {
    const r = await fetch(SERVICES_API);
    if (!r.ok) return new Set();
    const d = (await r.json()) as { services?: Array<{ id: string; installed?: boolean }> };
    return new Set((d.services ?? []).filter((s) => s.installed).map((s) => s.id));
  } catch {
    return new Set();
  }
}

export default function MarketplaceApp() {
  const registerApp = useOSStore((s) => s.registerApp);
  const installedApps = useOSStore((s) => s.apps);

  const [catalog, setCatalog] = useState<Catalog[]>([]);
  const [installedSkillIds, setInstalledSkillIds] = useState<Set<string>>(new Set());
  const [installedServiceIds, setInstalledServiceIds] = useState<Set<string>>(new Set());
  const [url, setUrl] = useState("");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [catalogRes, skillIds, serviceIds] = await Promise.all([
      fetch(API).then((r) => r.json() as Promise<{ marketplaces?: Catalog[] }>),
      fetchSkillIds(),
      fetchInstalledServiceIds(),
    ]);
    setCatalog(catalogRes.marketplaces ?? []);
    setInstalledSkillIds(skillIds);
    setInstalledServiceIds(serviceIds);
  }, []);

  useEffect(() => {
    let alive = true;
    Promise.all([
      fetch(API).then((r) => r.json() as Promise<{ marketplaces?: Catalog[] }>),
      fetchSkillIds(),
      fetchInstalledServiceIds(),
    ])
      .then(([catalogRes, skillIds, serviceIds]) => {
        if (!alive) return;
        setCatalog(catalogRes.marketplaces ?? []);
        setInstalledSkillIds(skillIds);
        setInstalledServiceIds(serviceIds);
      })
      .catch(() => {});
    return () => { alive = false; };
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

  const rawOp = useCallback(async (body: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const r = await fetch(API, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const d = (await r.json()) as Record<string, unknown>;
    if (!r.ok) throw new Error((d.error as string) || "Request failed");
    return d;
  }, []);

  /** An item is one thing, even when it bundles several installable facets
   *  (e.g. the Terminal item ships both an app and a service) — one click
   *  installs everything the item offers. Adopting a spec stays a separate
   *  action (it forks a copy for editing, not a running install). */
  const installItem = useCallback(
    async (marketplaceId: string, item: Item) => {
      setBusy(true);
      setError(null);
      setNotice(null);
      const installedKinds: string[] = [];
      try {
        if (item.app || item.services) {
          const d = await rawOp({ op: "install-item", id: marketplaceId, itemId: item.id });
          const installed = d.installed as { app?: AppManifest; serviceId?: string } | undefined;
          if (installed?.app) registerApp(installed.app);
          if (item.app) installedKinds.push("app");
          if (item.services) installedKinds.push("service");
        }
        if (item.skill) {
          await rawOp({ op: "install-skill", id: marketplaceId, itemId: item.id });
          installedKinds.push("skill");
        }
        await refresh();
        setNotice(
          `Installed "${item.name}"${installedKinds.length > 1 ? ` (${installedKinds.join(" + ")})` : ""} — ` +
            "find it on your desktop, or manage it in Settings → Plugins → Services.",
        );
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [rawOp, refresh, registerApp],
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

      {/* Filter */}
      <div className="border-b border-white/10 px-3 py-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter items…"
          className="w-full rounded-md bg-white/5 px-3 py-1.5 text-sm outline-none placeholder:text-white/30 focus:bg-white/10"
        />
      </div>

      {error && <div className="border-b border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">{error}</div>}
      {notice && <div className="border-b border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">{notice}</div>}

      <div className="flex-1 overflow-auto p-3">
        {catalog.length === 0 && (
          <div className="mt-10 text-center text-sm text-white/40">
            No marketplaces yet. Add one by its git URL above.
          </div>
        )}

        {catalog.map((mk) => {
          const q = query.trim().toLowerCase();
          const visibleItems = q
            ? mk.items.filter(
                (item) =>
                  item.name.toLowerCase().includes(q) ||
                  item.description.toLowerCase().includes(q) ||
                  item.tags?.some((t) => t.toLowerCase().includes(q)),
              )
            : mk.items;

          if (q && visibleItems.length === 0) return null;

          return (
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
                  {mk.id === LOCAL_MARKETPLACE_ID ? "Rescan" : "Sync"}
                </button>
                {mk.id !== LOCAL_MARKETPLACE_ID && (
                  <button
                    disabled={busy}
                    onClick={() => void op({ op: "remove", id: mk.id })}
                    className="rounded bg-white/10 px-2 py-1 text-xs hover:bg-red-500/30 disabled:opacity-40"
                  >
                    Remove
                  </button>
                )}
              </div>
            </header>

            {mk.error && <div className="px-3 pb-2 text-xs text-red-300">Manifest error: {mk.error}</div>}

            <div className="grid grid-cols-1 gap-2 p-3 sm:grid-cols-2">
              {visibleItems.map((item) => {
                const isSkillInstalled = !!item.skill && installedSkillIds.has(item.id);
                // App ids ARE item ids now (one item = one user-apps/<id>/ folder).
                const isAppInstalled = !!item.app && installedApps.some((a) => a.id === item.id);
                const isServiceInstalled = !!item.services && installedServiceIds.has(item.id);
                const hasInstallableFacet = !!(item.app || item.skill || item.services);
                const allFacetsInstalled =
                  (!item.app || isAppInstalled) && (!item.skill || isSkillInstalled) && (!item.services || isServiceInstalled);
                const installed = hasInstallableFacet && allFacetsInstalled;

                return (
                  <div
                    key={item.id}
                    className={`rounded-md border p-3 ${installed ? "border-emerald-500/30 bg-emerald-950/20" : "border-white/10 bg-white/5"}`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="text-sm font-medium leading-snug">{item.name}</div>
                      <div className="flex shrink-0 flex-wrap justify-end gap-1">
                        {installed && (
                          <span className="rounded bg-emerald-500/25 px-1.5 py-0.5 text-[10px] font-medium text-emerald-300">
                            ✓ installed
                          </span>
                        )}
                        {item.spec && <span className="rounded bg-purple-500/20 px-1.5 py-0.5 text-[10px] text-purple-300">spec</span>}
                        {item.app && <span className="rounded bg-sky-500/20 px-1.5 py-0.5 text-[10px] text-sky-300">app</span>}
                        {item.skill && <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 text-[10px] text-emerald-300">skill</span>}
                        {item.services && <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] text-amber-300">service</span>}
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
                      {hasInstallableFacet && (
                        <button
                          disabled={busy}
                          onClick={() => void installItem(mk.id, item)}
                          className="rounded bg-sky-600 px-2 py-1 text-xs font-medium hover:bg-sky-500 disabled:opacity-40"
                        >
                          {allFacetsInstalled ? "Reinstall" : "Install"}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
              {visibleItems.length === 0 && !mk.error && <div className="text-xs text-white/40">No items.</div>}
            </div>
          </section>
          );
        })}
      </div>
    </div>
  );
}
