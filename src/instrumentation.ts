// Next.js server-boot hook. Runs once per server process (dev + prod, and once
// per user container under the bastion). We use it to start the unified
// scheduler daemon so scheduled jobs — notably the fast/slow memory loops —
// actually fire on their interval without a UI being open. Before this, nothing
// called startDaemon(), so scheduled jobs only ran when triggered manually.
export async function register(): Promise<void> {
  // Only the Node.js runtime can run the daemon (fs, timers, server-only libs).
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const { startDaemon } = await import("@/lib/scheduler/daemon");
    startDaemon();
  } catch (err) {
    // Never let a scheduler-start failure crash server boot.
    console.error("[instrumentation] failed to start scheduler daemon:", err);
  }
}
