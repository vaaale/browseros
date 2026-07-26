// Next.js server-boot hook. Runs once per server process (dev + prod, and once
// per user container under the bastion). We load all plugins first so their
// lifecycle hooks (e.g. memory plugin seeding system jobs) run before the
// scheduler daemon starts ticking. Before this, nothing called startDaemon(),
// so scheduled jobs only ran when triggered manually.
export async function register(): Promise<void> {
  try {
    const { loadAllPlugins } = await import("@/lib/plugins/loader");
    await loadAllPlugins();

    // Register built-in plugins (compaction, memory) via their init modules.
    // These call registerPlugin() which does NOT call initialize() — we handle
    // that below. The imports are idempotent; route.ts also imports them.
    await import("@/plugins/compaction/init");
    await import("@/plugins/memory/init");

    // Initialize any active registered plugins whose initialize() hasn't been
    // called yet. loadAllPlugins() handles disk plugins; built-in plugins
    // registered via init.ts above are the ones that need this pass.
    // ensurePluginInitialized is idempotent and shared with the Settings
    // toggle path (src/lib/plugins/settings.ts), so both stay in sync.
    const { listPlugins, readPluginsConfig, ensurePluginInitialized } = await import("@/lib/plugins/registry");
    const config = await readPluginsConfig();
    const activeSet = new Set(config.active);

    for (const plugin of listPlugins()) {
      const id = plugin.manifest.id;
      if (!activeSet.has(id)) continue;
      try {
        await ensurePluginInitialized(id);
      } catch (err) {
        const { logger } = await import("@/lib/logging");
        logger().error("plugins", `plugin.initialize failed: ${id}`, undefined, {
          error: (err as Error).message,
        });
      }
    }

    // Service daemons (002-service-daemons): dataDir()/user-apps/ is the
    // user's own local marketplace — a GitFS repo, exactly like user-specs/,
    // that BOS never populates or deletes from. ensureRepo() only makes sure
    // it exists and is a git repo (a no-op if the user has already cloned
    // their own remote there); then discover installed services and start
    // them in dependency order. Awaited so the chat pipeline never starts
    // before services are ready (NFR-003) — a single service's failure is
    // logged and does NOT block the others or boot itself (CH-007).
    const { dataDir } = await import("@/os/data-dir");
    const { ensureRepo } = await import("@/lib/gitfs/store");
    const path = await import("path");
    await ensureRepo(path.join(dataDir(), "user-apps")).catch((err) => {
      console.error("[instrumentation] failed to ensure user-apps repo:", err);
    });
    const { serviceRegistry } = await import("@/core/service/ServiceRegistry");
    await serviceRegistry().initialize();
    const { serviceManager } = await import("@/core/service/ServiceManager");
    await serviceManager().startAll();

    const { startDaemon } = await import("@/lib/scheduler/daemon");
    startDaemon();
  } catch (err) {
    // Never let a scheduler-start failure crash server boot.
    console.error("[instrumentation] failed to start scheduler daemon:", err);
  }
}
