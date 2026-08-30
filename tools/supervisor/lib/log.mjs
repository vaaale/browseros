import { LogStore } from "../log-store.mjs";

// Central log store (specs/017-central-logging). The Supervisor is the SINGLE
// writer and always-on sink: frontend + version-server backends ship records
// here too.

/** @type {LogStore|null} */
let logStore = null;
let droppedLogWrites = 0;
let pruneFailures = 0;

export function initLogStore(canonicalData) {
  logStore = new LogStore(canonicalData);
  return logStore;
}

export function getLogStore() {
  return logStore;
}

export function getLogHealth() {
  return { droppedLogWrites, pruneFailures };
}

// A logging failure must never crash the caller it's instrumenting — but
// "never crash the caller" doesn't mean "vanish without a trace": every drop
// is counted so a persistently-broken log sink is visible via
// /__supervisor/health instead of silently writing nothing forever.
function writeSafely(record, opts) {
  try {
    logStore.write(record, opts);
  } catch (e) {
    droppedLogWrites += 1;
    console.error("[supervisor] log write dropped:", e?.message || e);
  }
}

// console + persist. log() mirrors every supervisor message into the store
// (supervisor stream); slog() adds structured fields (branch, versionLabel,
// err, buildLog, …).
export const log = (...a) => {
  console.log("[supervisor]", ...a);
  writeSafely({ level: "info", stream: "supervisor", component: "supervisor", msg: a.map(String).join(" ") }, { versionLabel: "supervisor" });
};

export const slog = (level, component, msg, extra = {}) => {
  console.log("[supervisor]", msg);
  writeSafely({ level, stream: "supervisor", component, msg, ...extra }, { versionLabel: "supervisor" });
};

async function pruneOnce() {
  try {
    await logStore.prune();
  } catch (e) {
    pruneFailures += 1;
    slog("warn", "log", `log prune failed (${pruneFailures} failure(s) so far): ${e?.message || e}`, {});
  }
}

// Was `void logStore.prune()` with NO `.catch` at all — a genuine unhandled
// promise rejection. Now every failure is caught, logged, and counted
// (getLogHealth()) instead of silently never running again.
export function startPruneInterval(intervalMs = 3_600_000) {
  void pruneOnce();
  return setInterval(() => void pruneOnce(), intervalMs);
}
