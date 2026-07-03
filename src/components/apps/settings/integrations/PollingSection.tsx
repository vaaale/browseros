"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Bell, RefreshCw, Save } from "lucide-react";
import type { IntegrationSummary } from "./useIntegrations";
import type { PollConfig, SchedulerJobStatus, SchedulerStatus } from "@/lib/integrations/scheduler/types";
import { MAX_INTERVAL_SEC, MIN_INTERVAL_SEC } from "@/lib/integrations/scheduler/types";

// Poll config UI: toggle, interval, "poll now", + live status from the scheduler
// daemon (last attempt / success, failures, backoff, next-eligible countdown).

interface PollingSectionProps {
  item: IntegrationSummary;
  serviceId: string;
  onPatch: (id: string, body: unknown) => Promise<void>;
}

interface IntervalOption {
  label: string;
  seconds: number;
}

const INTERVAL_OPTIONS: IntervalOption[] = [
  { label: "30 seconds", seconds: 30 },
  { label: "1 minute", seconds: 60 },
  { label: "5 minutes", seconds: 5 * 60 },
  { label: "15 minutes", seconds: 15 * 60 },
  { label: "30 minutes", seconds: 30 * 60 },
];

const DEFAULT_INTERVAL_SEC = 300;

function clamp(sec: number): number {
  if (!Number.isFinite(sec) || sec <= 0) return DEFAULT_INTERVAL_SEC;
  return Math.max(MIN_INTERVAL_SEC, Math.min(MAX_INTERVAL_SEC, Math.floor(sec)));
}

function readPollConfig(item: IntegrationSummary, serviceId: string): PollConfig {
  const svc = item.state.services[serviceId];
  const stored = (svc?.config?.poll as PollConfig | undefined) ?? undefined;
  return {
    enabled: stored?.enabled ?? false,
    intervalSec: clamp(stored?.intervalSec ?? DEFAULT_INTERVAL_SEC),
    lastError: stored?.lastError,
    retryAfter: stored?.retryAfter,
    backoffSec: stored?.backoffSec,
    failures: stored?.failures,
    extras: stored?.extras,
  };
}

function formatRelative(ts: number | undefined, now: number): string {
  if (!ts) return "—";
  const diff = ts - now;
  const abs = Math.abs(Math.round(diff / 1000));
  if (abs < 60) return diff >= 0 ? `in ${abs}s` : `${abs}s ago`;
  const mins = Math.round(abs / 60);
  if (mins < 60) return diff >= 0 ? `in ${mins}m` : `${mins}m ago`;
  const hours = Math.round(mins / 60);
  return diff >= 0 ? `in ${hours}h` : `${hours}h ago`;
}

export function PollingSection({ item, serviceId, onPatch }: PollingSectionProps) {
  const persisted = useMemo(() => readPollConfig(item, serviceId), [item, serviceId]);
  const [enabled, setEnabled] = useState<boolean>(persisted.enabled);
  const [intervalSec, setIntervalSec] = useState<number>(persisted.intervalSec);
  const [saving, setSaving] = useState(false);
  const [polling, setPolling] = useState(false);
  const [pollResult, setPollResult] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  const [status, setStatus] = useState<SchedulerStatus | undefined>();
  const [now, setNow] = useState<number>(() => Date.now());
  const statusInFlight = useRef(false);

  // Re-seed drafts when the persisted state changes (e.g. after a save/refresh).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setEnabled(persisted.enabled);
    setIntervalSec(persisted.intervalSec);
  }, [persisted.enabled, persisted.intervalSec]);

  const loadStatus = useCallback(async () => {
    if (statusInFlight.current) return;
    statusInFlight.current = true;
    try {
      const res = await fetch("/api/integrations/scheduler");
      if (!res.ok) return;
      const body = (await res.json()) as { status: SchedulerStatus };
      setStatus(body.status);
    } catch {
      // best-effort
    } finally {
      statusInFlight.current = false;
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadStatus();
    const interval = setInterval(() => {
      setNow(Date.now());
      void loadStatus();
    }, 5000);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(interval);
      clearInterval(tick);
    };
  }, [loadStatus]);

  const dirty = useMemo(() => {
    return enabled !== persisted.enabled || intervalSec !== persisted.intervalSec;
  }, [enabled, intervalSec, persisted.enabled, persisted.intervalSec]);

  const save = useCallback(async () => {
    setSaving(true);
    setError(undefined);
    try {
      const svcState = item.state.services[serviceId];
      const existingPoll = (svcState?.config?.poll as PollConfig | undefined) ?? undefined;
      const nextPoll: PollConfig = {
        ...(existingPoll ?? {}),
        enabled,
        intervalSec: clamp(intervalSec),
      };
      await onPatch(item.manifest.id, {
        services: {
          [serviceId]: {
            config: { poll: nextPoll },
          },
        },
      });
      await loadStatus();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }, [enabled, intervalSec, item.manifest.id, item.state.services, loadStatus, onPatch, serviceId]);

  const pollNow = useCallback(async () => {
    setPolling(true);
    setPollResult(undefined);
    setError(undefined);
    try {
      const res = await fetch(
        `/api/integrations/${encodeURIComponent(item.manifest.id)}/services/${encodeURIComponent(serviceId)}/poll`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
      );
      const body = (await res.json()) as {
        newMessages?: number;
        emitted?: number;
        error?: { message?: string };
      };
      if (!res.ok) throw new Error(body.error?.message ?? `Poll failed: ${res.status}`);
      const count = body.newMessages ?? 0;
      setPollResult(`Polled: ${count} new event${count === 1 ? "" : "s"}.`);
      await loadStatus();
    } catch (e) {
      setPollResult(`Error: ${(e as Error).message}`);
    } finally {
      setPolling(false);
    }
  }, [item.manifest.id, loadStatus, serviceId]);

  const jobStatus: SchedulerJobStatus | undefined = useMemo(() => {
    return status?.jobs.find(
      (j) => j.integrationId === item.manifest.id && j.serviceId === serviceId,
    );
  }, [status, item.manifest.id, serviceId]);

  const canPoll = item.state.connected && item.state.services[serviceId]?.enabled !== false;
  const activeError = persisted.lastError ?? jobStatus?.lastError;
  const failures = jobStatus?.failures ?? persisted.failures ?? 0;
  const backoffActive = persisted.retryAfter && persisted.retryAfter > now;

  return (
    <section className="rounded-lg border border-white/10 bg-white/[0.03] p-3">
      <div className="mb-3 flex items-center justify-between">
        <h4 className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-white/40">
          <Bell size={12} /> Polling
          {status?.running && (
            <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-normal normal-case text-emerald-300">
              Daemon running
            </span>
          )}
        </h4>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={pollNow}
            disabled={polling || !canPoll}
            className="inline-flex items-center gap-1.5 rounded border border-white/15 px-2.5 py-1 text-[11px] font-medium text-white/80 transition-colors hover:bg-white/10 disabled:opacity-40"
          >
            <RefreshCw size={12} className={polling ? "animate-spin" : undefined} />
            {polling ? "Polling…" : "Poll now"}
          </button>
          <button
            type="button"
            onClick={save}
            disabled={!dirty || saving}
            className="inline-flex items-center gap-1.5 rounded bg-violet-500/80 px-2.5 py-1 text-[11px] font-medium text-white transition-colors hover:bg-violet-500 disabled:opacity-50"
          >
            <Save size={12} /> {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>

      <div className="space-y-3">
        <label className="flex items-center gap-3 text-[12px]">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="h-3.5 w-3.5 accent-violet-500"
            disabled={!canPoll}
          />
          <span>
            <span className="font-medium">Enable automatic polling</span>
            <span className="ml-2 text-white/50">
              — the daemon will poll at the interval below.
            </span>
          </span>
        </label>

        <label className="block space-y-1 text-[11px]">
          <span className="text-white/60">Interval</span>
          <select
            value={
              INTERVAL_OPTIONS.some((o) => o.seconds === intervalSec) ? intervalSec : "custom"
            }
            onChange={(e) => {
              const v = e.target.value;
              if (v === "custom") return;
              setIntervalSec(Number(v));
            }}
            disabled={!canPoll}
            className="w-full max-w-[220px] rounded border border-white/10 bg-black/20 px-2 py-1 text-[12px] text-white/80 disabled:opacity-50"
          >
            {INTERVAL_OPTIONS.map((o) => (
              <option key={o.seconds} value={o.seconds}>
                {o.label}
              </option>
            ))}
            {!INTERVAL_OPTIONS.some((o) => o.seconds === intervalSec) && (
              <option value="custom">{`Custom (${intervalSec}s)`}</option>
            )}
          </select>
          <span className="block text-[10px] text-white/40">
            Bounded to {MIN_INTERVAL_SEC}s–{Math.round(MAX_INTERVAL_SEC / 60)}min.
          </span>
        </label>

        {/* Live status */}
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 rounded border border-white/5 bg-black/10 px-3 py-2 text-[11px]">
          <span className="text-white/40">Last attempt</span>
          <span className="text-white/70">{formatRelative(jobStatus?.lastAttemptAt, now)}</span>
          <span className="text-white/40">Last success</span>
          <span className="text-white/70">{formatRelative(jobStatus?.lastSuccessAt, now)}</span>
          {backoffActive ? (
            <>
              <span className="text-amber-400/80">Backoff until</span>
              <span className="text-amber-200/80">
                {formatRelative(persisted.retryAfter, now)}
                {persisted.backoffSec ? ` (${persisted.backoffSec}s wait)` : ""}
              </span>
            </>
          ) : (
            <>
              <span className="text-white/40">Next eligible</span>
              <span className="text-white/70">
                {formatRelative(jobStatus?.nextEligibleAt, now)}
              </span>
            </>
          )}
          {failures > 0 && (
            <>
              <span className="text-white/40">Failures</span>
              <span className="text-red-300">{failures}</span>
            </>
          )}
        </div>

        {activeError && (
          <div className="flex items-start gap-2 rounded border border-red-400/30 bg-red-500/10 p-2 text-[11px] text-red-200">
            <AlertCircle size={12} className="mt-0.5 shrink-0" />
            <span>{activeError}</span>
          </div>
        )}

        {pollResult && (
          <p className="text-[11px] text-white/70">{pollResult}</p>
        )}

        {error && (
          <div className="flex items-start gap-2 rounded border border-red-400/30 bg-red-500/10 p-2 text-[11px] text-red-200">
            <AlertCircle size={12} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {!item.state.connected && (
          <p className="text-[11px] text-white/40">
            Connect the integration first to enable polling.
          </p>
        )}
      </div>
    </section>
  );
}
