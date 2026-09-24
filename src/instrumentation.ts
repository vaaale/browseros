// Next.js server-boot hook. Runs once per server process (dev + prod, and once
// per user container under the bastion).
//
// This is the ONLY instrumentation file. Next.js resolves the hook from either
// `<root>/instrumentation.ts` or `<root>/src/instrumentation.ts`, and when both
// exist one silently wins — which has twice disabled everything below (a Jul 22
// rename to `instrumentation.node.ts`, then a Jul 28 root-level duplicate).
// Both times the symptom was identical: no services, no scheduler, no error.
// Keep all startup logic here, in this file, under this name.
export async function register(): Promise<void> {
  // Only the Node.js runtime can run any of this (fs, worker_threads, timers,
  // server-only libs).
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  try {
    // Method packs (045): register the built-in spec-kit descriptor BEFORE the
    // first spec-store read. Every Build Studio surface resolves a descriptor,
    // and an unresolved one is refused rather than defaulted (FR-016) — so
    // ordering is load-bearing, not cosmetic. ensureSystemMounts/
    // ensureStoresOnce run lazily on first access (os/vfs.ts), which makes
    // "whoever touches a store first" the real trigger; registering up here
    // means no route can win that race.
    //
    // Asserted rather than left to import side-effects: a descriptor that
    // silently failed to register surfaces as an EMPTY store, which reads as
    // data loss rather than as a boot-order bug.
    // 046 T004: the built-in spec-kit PACK, registered through the same
    // sequence a marketplace pack's install uses — descriptor, agent root,
    // template mount. Extends 045 T006a rather than adding a second hook.
    const { registerBuiltinPack } = await import("@/lib/specs/method/builtin-pack");
    const { getMethod } = await import("@/lib/specs/method/registry");
    await registerBuiltinPack();
    if (!getMethod("spec-kit")) throw new Error("built-in spec-kit method failed to register");

    // Installed method packs. Without this a pack registers at INSTALL and
    // never again — it works until the first restart, then silently vanishes
    // while its symlink, overlay and marketplace entry all still say installed.
    // Runs after the built-in so spec-kit is always present even if a pack
    // fails, and before the first spec-store read for the same reason the
    // built-in does.
    const { registerInstalledMethodPacks } = await import("@/lib/specs/method/install");
    await registerInstalledMethodPacks();

    // Assistant plugins (compaction, memory, …). Loaded before the scheduler so
    // their lifecycle hooks (e.g. the memory plugin seeding system jobs) run
    // before the daemon starts ticking.
    const { loadAllPlugins } = await import("@/lib/plugins/loader");
    await loadAllPlugins();

    // Built-in plugins register via their init modules, which call
    // registerPlugin() but NOT initialize() — the pass below handles that.
    // Imports are idempotent; route.ts imports them too.
    await import("@/plugins/compaction/init");
    await import("@/plugins/memory/init");
    // 031-self-healing: the trigger-capture plugin (hard-error +
    // repeated-failure). Its hooks fire on main chat runs only — headless runs
    // pass no `hooks` into the loop — which is what keeps the mechanism from
    // diagnosing its own runs (design ADR-4).
    await import("@/plugins/self-heal/init");

    // ensurePluginInitialized is idempotent and shared with the Settings toggle
    // path (src/lib/plugins/settings.ts), so both stay in sync.
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

    // Service daemons (002-service-daemons): dataDir()/user-apps/ is the user's
    // own local marketplace — a GitFS repo, exactly like user-specs/, that BOS
    // never populates or deletes from. ensureRepo() only makes sure it exists
    // and is a git repo (a no-op if the user already cloned their own remote
    // there); then discover installed services and start them in dependency
    // order. Awaited so the chat pipeline never starts before services are
    // ready (NFR-003) — a single service's failure is logged and does NOT block
    // the others or boot itself (CH-007).
    const { dataDir } = await import("@/os/data-dir");
    const { ensureRepo } = await import("@/lib/gitfs/store");
    // String join, not path.join(), so this file never imports the "path"
    // builtin directly — Next.js statically flags any Node module imported
    // right in instrumentation.ts as Edge-incompatible, even though the
    // NEXT_RUNTIME guard above means this line never runs on Edge.
    await ensureRepo(`${dataDir()}/user-apps`).catch((err) => {
      console.error("[instrumentation] failed to ensure user-apps repo:", err);
    });

    // Migrate a pre-034 flat user-apps to the items/ marketplace layout, and
    // re-point the installed-state symlinks that would otherwise all dangle.
    // Must run BEFORE the service registry scans items/. Idempotent.
    const { migrateUserAppsLayout } = await import("@/lib/marketplace/migrate-user-apps");
    await migrateUserAppsLayout().catch((err) => {
      console.error("[instrumentation] user-apps layout migration failed:", err);
    });

    // Convert pre-035 installed state (per-facet symlinks, config behind
    // config/<id>) to one symlink per item plus seeded system/config/<id>.
    // Must run BEFORE the service registry reads configDirPath. Idempotent.
    const { migrateInstalledState } = await import("@/lib/marketplace/migrate-installed-state");
    await migrateInstalledState().catch((err) => {
      console.error("[instrumentation] installed-state migration failed:", err);
    });

    // BOS plugins are ordinary item facets now (035), discovered through
    // dataDir()/system/<id>/plugin — so they MUST load AFTER the migrations
    // above have put the item symlinks in place. Loading them first (as an
    // earlier revision did) silently loaded nothing on the boot that migrated.
    const { loadAllPlugins: loadBosPlugins } = await import("@/lib/bos-plugins/loader");
    await loadBosPlugins();

    const { serviceRegistry } = await import("@/core/service/ServiceRegistry");
    await serviceRegistry().initialize();
    const { serviceManager } = await import("@/core/service/ServiceManager");
    await serviceManager().startAll();

    // Scheduler daemon (042-scheduler-daemon-lock). EVERY server process runs
    // this hook — the Supervisor keeps a BASE and (while previewing a feature
    // branch) a PREVIEW alive, and `next dev` adds more — so before the fix
    // each one started its own ticking daemon over the same jobs and a single
    // due job fired N times (N concurrent "Daily Review" runs). startDaemon()
    // is now election-gated: it competes for the container-wide daemon lock
    // under <canonical data>/scheduler/daemon.lock and only the winner ticks;
    // losers keep polling so a crashed owner is taken over. Deliberately kept
    // inside startDaemon() rather than open-coded here, so every entry point
    // into the engine (routes, tests) gets the same guarantee.
    const { startDaemon } = await import("@/lib/scheduler/daemon");
    startDaemon();

    // Event & notification kernel (034-event-notification-system): migrate
    // the legacy notifications inbox BEFORE the kernel starts serving, so the
    // first dispatch cycle already sees migrated events (R6), then start the
    // kernel (loads the store, rebuilds/repairs the index, re-dispatches any
    // un-acked events — FR-005a).
    const { migrateIntegrationsToEvents } = await import("@/lib/events/migrate-integrations");
    await migrateIntegrationsToEvents().catch((err) => {
      console.error("[instrumentation] legacy notifications migration failed:", err);
    });
    const { startEventKernel } = await import("@/lib/events/kernel");
    await startEventKernel();
    const { registerAllUiHandlers } = await import("@/lib/events/register-ui-handlers");
    await registerAllUiHandlers().catch((err) => {
      console.error("[instrumentation] registering UI event handlers failed:", err);
    });

    // Git conflict-resolution sessions (035, FR-024). Must run AFTER the event
    // kernel and the UI-handler registration: the sweep re-emits
    // com.bos.gitops.conflict.escalated for every session that survived the
    // restart, which is what re-opens the Build Studio conflict pane. A
    // `working` session's agent run died with the previous process and is
    // re-launched here; an `awaiting-user` one is restored and left parked.
    const { recoverSessions } = await import("@/lib/gitops/sessions/recover");
    await recoverSessions().catch((err) => {
      console.error("[instrumentation] conflict-session recovery failed:", err);
    });

    // Self-healing mechanism (031-self-healing). Ordered AFTER the event kernel
    // (the spine is a 034 core headless handler) and after the scheduler (the
    // boot reconcile borrows its daemon lock, and the scheduled Diagnostician is
    // a system job).
    //
    // The reconcile MUST be single-owner: every server process runs this hook,
    // and the Supervisor keeps a BASE plus (while previewing) a PREVIEW alive —
    // two processes both re-deriving "this preview is ready" would emit
    // `fix_ready` twice for the same case (design R9). The scheduler's
    // container-wide daemon lock is the existing election mechanism, so the
    // reconcile competes for it rather than inventing a second one.
    try {
      const { registerSelfHealSpine } = await import("@/lib/self-heal/spine-handler");
      await registerSelfHealSpine();

      const { ensureScheduledDiagnosticianJob } = await import("@/lib/self-heal/diagnostician");
      await ensureScheduledDiagnosticianJob().catch((err) => {
        console.error("[instrumentation] seeding the scheduled Diagnostician job failed:", err);
      });

      const { acquireLock, releaseLock } = await import("@/lib/scheduler/lock");
      const handle = await acquireLock("self-heal-reconcile", { label: process.env.BOS_VERSION_LABEL });
      if (handle) {
        try {
          const { reconcileInFlightCases } = await import("@/lib/self-heal/intake");
          const summary = await reconcileInFlightCases();
          if (summary.fixReadyEmitted.length || summary.failed.length || summary.abandoned.length || summary.requeued.length) {
            console.log("[instrumentation] self-heal reconcile:", JSON.stringify(summary));
          }
        } finally {
          await releaseLock(handle);
        }
      }
    } catch (err) {
      console.error("[instrumentation] self-heal startup failed:", err);
    }
  } catch (err) {
    // Never let a startup failure crash server boot.
    console.error("[instrumentation] server-boot hook failed:", err);
  }
}
