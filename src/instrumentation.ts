// Next.js server-boot hook. Runs once per server process (dev + prod, and once
// per user container under the bastion). We load all plugins first so their
// lifecycle hooks (e.g. memory plugin seeding system jobs) run before the
// scheduler daemon starts ticking. Before this, nothing called startDaemon(),
// so scheduled jobs only ran when triggered manually.
export async function register(): Promise<void> {
  // Only the Node.js runtime can run the daemon (fs, timers, server-only libs).
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
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
    const {
      listPlugins,
      readPluginsConfig,
      getPluginContext,
      setPluginContext,
    } = await import("@/lib/plugins/registry");
    const config = await readPluginsConfig();
    const activeSet = new Set(config.active);

    for (const plugin of listPlugins()) {
      const id = plugin.manifest.id;
      if (!activeSet.has(id)) continue;
      if (getPluginContext(id)) continue; // already initialized (e.g. by loadAllPlugins)
      if (!plugin.initialize) continue;

      const { logger } = await import("@/lib/logging");
      const { dataDir } = await import("@/os/data-dir");
      const path = await import("path");
      const { promises: fs } = await import("fs");

      const pluginDir = path.default.join(dataDir(), "plugins", id);
      const ctx = {
        dataDir: dataDir(),
        readFile: async (rel: string) =>
          fs.readFile(path.default.join(pluginDir, rel), "utf8"),
        writeFile: async (rel: string, content: string) => {
          const fullPath = path.default.join(pluginDir, rel);
          await fs.mkdir(path.default.dirname(fullPath), { recursive: true });
          await fs.writeFile(fullPath, content, "utf8");
        },
        readTranscript: async (convId: string) => {
          const { loadConversationMessages } = await import(
            "@/lib/assistant/conversation-store"
          );
          return loadConversationMessages(convId);
        },
        log: (
          level: "debug" | "info" | "warn" | "error",
          msg: string,
          data?: Record<string, unknown>,
        ) => {
          logger().log({
            level,
            component: `plugins.${id}`,
            msg,
            ...(data ? { data } : {}),
          });
        },
      };
      setPluginContext(id, ctx);
      try {
        await plugin.initialize(ctx);
        logger().info("plugins", `plugin.initialized: ${id}`);
      } catch (err) {
        logger().error("plugins", `plugin.initialize failed: ${id}`, undefined, {
          error: (err as Error).message,
        });
      }
    }

    const { startDaemon } = await import("@/lib/scheduler/daemon");
    startDaemon();
  } catch (err) {
    // Never let a scheduler-start failure crash server boot.
    console.error("[instrumentation] failed to start scheduler daemon:", err);
  }
}
