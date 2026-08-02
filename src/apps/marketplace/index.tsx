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
  // BOS plugin facets. An item can be plugin-ONLY (Live Avatar is a voice engine
  // with no app of its own), so leaving these out of the installable set made such
  // an item look like it had nothing to install.
  voiceEngine?: { version: string; engineId?: string };
  integration?: { version: string };
  serverPlugin?: { version: string };
}

/** Does this item ship a BOS plugin (voice engine, integration or server plugin)?
 *  All three install through the same `install-item` op. */
function hasPluginFacet(item: Item): boolean {
  return !!(item.voiceEngine || item.integration || item.serverPlugin);
}

/** The local marketplace slot: the repo at dataDir()/user-apps/, which has the
 *  same layout as any registered clone (034). This id keys the SLOT by location,
 *  not the repo's identity — the section title comes from its own manifest. */
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
  const unregisterApp = useOSStore((s) => s.unregisterApp);
  const installedApps = useOSStore((s) => s.apps);

  const [catalog, setCatalog] = useState<Catalog[]>([]);
  const [installedSkillIds, setInstalledSkillIds] = useState<Set<string>>(new Set());
  const [installedServiceIds, setInstalledServiceIds] = useState<Set<string>>(new Set());
  /** Every installed item id (035's shared scan). A plugin facet has no registry
   *  of its own, so this is the only thing that can answer "installed?" for it. */
  const [installedItemIds, setInstalledItemIds] = useState<Set<string>>(new Set());
  const [url, setUrl] = useState("");
  const [query, setQuery] = useState("");
  /** Master selection: null = "All" (no repo filter). */
  const [selectedRepo, setSelectedRepo] = useState<string | null>(null);
  /** Repos the user has collapsed in the main view. Expanded is the default. */
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [catalogRes, skillIds, serviceIds] = await Promise.all([
      fetch(API).then((r) => r.json() as Promise<{ marketplaces?: Catalog[]; installedItemIds?: string[] }>),
      fetchSkillIds(),
      fetchInstalledServiceIds(),
    ]);
    setCatalog(catalogRes.marketplaces ?? []);
    setInstalledItemIds(new Set(catalogRes.installedItemIds ?? []));
    setInstalledSkillIds(skillIds);
    setInstalledServiceIds(serviceIds);
  }, []);

  useEffect(() => {
    let alive = true;
    Promise.all([
      fetch(API).then((r) => r.json() as Promise<{ marketplaces?: Catalog[]; installedItemIds?: string[] }>),
      fetchSkillIds(),
      fetchInstalledServiceIds(),
    ])
      .then(([catalogRes, skillIds, serviceIds]) => {
        if (!alive) return;
        setCatalog(catalogRes.marketplaces ?? []);
        setInstalledItemIds(new Set(catalogRes.installedItemIds ?? []));
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
        // ONE op covers every non-skill facet — installMarketplaceItem installs the
        // app, the service and the plugin, in that dependency order.
        if (item.app || item.services || hasPluginFacet(item)) {
          const d = await rawOp({ op: "install-item", id: marketplaceId, itemId: item.id });
          const installed = d.installed as { app?: AppManifest; serviceId?: string; pluginId?: string } | undefined;
          if (installed?.app) registerApp(installed.app);
          if (item.app) installedKinds.push("app");
          if (item.services) installedKinds.push("service");
          if (installed?.pluginId) installedKinds.push("plugin");
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

  /** Uninstall whatever the item installed — the mirror of installItem. One op,
   *  because the server dispatches on the INSTALLED facets rather than on what a
   *  manifest currently claims. */
  const uninstallItem = useCallback(
    async (item: Item) => {
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        await rawOp({ op: "uninstall-item", itemId: item.id });
        unregisterApp(item.id);
        await refresh();
        setNotice(`Uninstalled "${item.name}".`);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [rawOp, refresh, unregisterApp],
  );

  const toggleCollapsed = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  /** Selecting a repo in the sidebar also expands it — selecting something only
   *  to find it collapsed would be a dead end. */
  const selectRepo = useCallback((id: string | null) => {
    setSelectedRepo(id);
    if (id) setCollapsed((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  // Text query and repo selection are independent filters. Compute the query
  // result once per repo so the sidebar's counts and the main view can never
  // disagree about how many items match.
  const q = query.trim().toLowerCase();
  const byRepo = catalog.map((mk) => ({
    mk,
    items: q
      ? mk.items.filter(
          (item) =>
            item.name.toLowerCase().includes(q) ||
            item.description.toLowerCase().includes(q) ||
            item.tags?.some((t) => t.toLowerCase().includes(q)),
        )
      : mk.items,
  }));
  const shown = byRepo.filter(({ mk }) => selectedRepo === null || mk.id === selectedRepo);
  const totalMatches = byRepo.reduce((n, r) => n + r.items.length, 0);

  return (
    <div className="flex h-full bg-neutral-950 text-neutral-100">
      {/* ── Master: repo list ──────────────────────────────────────────────── */}
      <aside className="flex w-56 shrink-0 flex-col border-r border-white/10">
        <div className="px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-white/40">Sources</div>
        <nav className="flex-1 overflow-auto px-1.5 pb-2">
          <SidebarEntry
            label="All"
            count={totalMatches}
            active={selectedRepo === null}
            onClick={() => selectRepo(null)}
          />
          <div className="my-1.5 border-t border-white/5" />
          {byRepo.map(({ mk, items }) => (
            <SidebarEntry
              key={mk.id}
              label={mk.name}
              count={items.length}
              active={selectedRepo === mk.id}
              hasError={!!mk.error}
              local={mk.id === LOCAL_MARKETPLACE_ID}
              onClick={() => selectRepo(mk.id)}
            />
          ))}
          {catalog.length === 0 && <div className="px-2 py-1.5 text-xs text-white/30">No sources</div>}
        </nav>
      </aside>

      {/* ── Detail: items ─────────────────────────────────────────────────── */}
      <div className="flex min-w-0 flex-1 flex-col">
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

        {shown.map(({ mk, items: visibleItems }) => {
          if (q && visibleItems.length === 0) return null;
          const isCollapsed = collapsed.has(mk.id);

          return (
          <section key={mk.id} className="mb-5 rounded-lg border border-white/10">
            <header className="flex items-center justify-between gap-2 px-3 py-2">
              {/* The header itself toggles collapse; the actions below stop
                  propagation so Sync/Remove never fold the section by accident. */}
              <button
                onClick={() => toggleCollapsed(mk.id)}
                aria-expanded={!isCollapsed}
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
              >
                <span className={`shrink-0 text-white/40 transition-transform ${isCollapsed ? "" : "rotate-90"}`}>▶</span>
                <span className="min-w-0">
                  <span className="block truncate text-sm font-semibold">{mk.name}</span>
                  <span className="block truncate text-xs text-white/40">{mk.url}</span>
                </span>
                <span className="ml-1 shrink-0 rounded bg-white/10 px-1.5 py-0.5 text-[10px] text-white/50">
                  {visibleItems.length}
                </span>
              </button>
              <div className="flex shrink-0 gap-2" onClick={(e) => e.stopPropagation()}>
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

            {!isCollapsed && (
            <div className="grid grid-cols-1 gap-2 p-3 sm:grid-cols-2">
              {visibleItems.map((item) => {
                const isSkillInstalled = !!item.skill && installedSkillIds.has(item.id);
                const isPluginInstalled = hasPluginFacet(item) && installedItemIds.has(item.id);
                // App ids ARE item ids (one item = one <marketplace>/items/<id>/ folder).
                const isAppInstalled = !!item.app && installedApps.some((a) => a.id === item.id);
                const isServiceInstalled = !!item.services && installedServiceIds.has(item.id);
                const hasInstallableFacet = !!(item.app || item.skill || item.services) || hasPluginFacet(item);
                const allFacetsInstalled =
                  (!item.app || isAppInstalled) && (!item.skill || isSkillInstalled) && (!item.services || isServiceInstalled) &&
                  (!hasPluginFacet(item) || isPluginInstalled);
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
                        {item.voiceEngine && <span className="rounded bg-rose-500/20 px-1.5 py-0.5 text-[10px] text-rose-300">voice engine</span>}
                        {item.integration && <span className="rounded bg-rose-500/20 px-1.5 py-0.5 text-[10px] text-rose-300">integration</span>}
                        {item.serverPlugin && <span className="rounded bg-rose-500/20 px-1.5 py-0.5 text-[10px] text-rose-300">plugin</span>}
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
                      {installed && (
                        <button
                          disabled={busy}
                          onClick={() => void uninstallItem(item)}
                          className="rounded bg-white/10 px-2 py-1 text-xs font-medium hover:bg-red-500/30 disabled:opacity-40"
                        >
                          Uninstall
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
              {visibleItems.length === 0 && !mk.error && <div className="text-xs text-white/40">No items.</div>}
            </div>
            )}
          </section>
          );
        })}
      </div>
      </div>
    </div>
  );
}

/** One row in the master list. `local` marks the user's own marketplace slot. */
function SidebarEntry({
  label, count, active, onClick, hasError, local,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
  hasError?: boolean;
  local?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      aria-current={active ? "true" : undefined}
      title={label}
      className={`mb-0.5 flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs ${
        active ? "bg-white/15 text-white" : "text-white/60 hover:bg-white/5 hover:text-white/90"
      }`}
    >
      <span className="min-w-0 flex-1 truncate">
        {label}
        {local && <span className="ml-1 text-[10px] text-white/30">(yours)</span>}
      </span>
      {hasError && <span className="shrink-0 text-[10px] text-red-400">!</span>}
      <span className="shrink-0 text-[10px] text-white/35">{count}</span>
    </button>
  );
}
