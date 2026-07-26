"use client";

// Settings → Plugins → [Services] section (002-service-daemons, Phase 4).
// Lists installed services and keeps them live via the /api/services/events
// NDJSON stream — same replay-then-tail pattern as run-client.ts's
// attachToRun, but for ServiceRegistryEvent instead of RunEvent.

import { useCallback, useEffect, useRef, useState } from "react";
import type { ServiceRegistryEvent, ServiceStatusView } from "@/core/service/types";
import { ServiceCard, type ServiceAction } from "./ServiceCard";

export interface ServicesTabSelection {
  id: string;
  view: "config" | "logs";
}

export interface ServicesTabProps {
  selected: ServicesTabSelection | null;
  onOpenConfig: (serviceId: string) => void;
  onOpenLogs: (serviceId: string) => void;
}

async function loadServices(): Promise<ServiceStatusView[]> {
  const res = await fetch("/api/services");
  const data = (await res.json()) as { services?: ServiceStatusView[] };
  return (data.services ?? []).filter((s) => s.installed);
}

export function ServicesTab({ selected, onOpenConfig, onOpenLogs }: ServicesTabProps) {
  const [services, setServices] = useState<ServiceStatusView[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const lastSeq = useRef(0);

  const refresh = useCallback(async () => {
    try {
      setServices(await loadServices());
    } catch {
      /* keep showing the last known list */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const id = setTimeout(() => void refresh(), 0);
    return () => clearTimeout(id);
  }, [refresh]);

  // Live updates: replay events since the last seen seq, then tail forever.
  // Reconnects on transient drops; the effect's AbortController stops the
  // loop on unmount.
  useEffect(() => {
    const controller = new AbortController();

    async function attach() {
      for (;;) {
        if (controller.signal.aborted) return;
        try {
          const res = await fetch(`/api/services/events?since=${lastSeq.current}`, {
            signal: controller.signal,
          });
          if (!res.ok || !res.body) throw new Error(`events stream: HTTP ${res.status}`);
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buf = "";
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            let nl: number;
            while ((nl = buf.indexOf("\n")) >= 0) {
              const line = buf.slice(0, nl).trim();
              buf = buf.slice(nl + 1);
              if (!line) continue;
              let parsed: (ServiceRegistryEvent & { seq: number; ts: number }) | { type: "ping" };
              try {
                parsed = JSON.parse(line);
              } catch {
                continue;
              }
              if (parsed.type === "ping") continue;
              lastSeq.current = Math.max(lastSeq.current, parsed.seq);
              applyEvent(parsed);
            }
          }
        } catch {
          if (controller.signal.aborted) return;
        }
        if (controller.signal.aborted) return;
        await new Promise((r) => setTimeout(r, 1000));
      }
    }

    function applyEvent(event: ServiceRegistryEvent) {
      switch (event.type) {
        case "service:status:changed":
          setServices((prev) => prev.map((s) => (s.id === event.id ? { ...s, state: event.state } : s)));
          break;
        case "service:bound":
          setServices((prev) =>
            prev.map((s) => (s.id === event.id ? { ...s, boundPort: event.port, boundHost: event.host } : s)),
          );
          break;
        case "service:crash":
          setServices((prev) =>
            prev.map((s) => (s.id === event.id ? { ...s, restartCount: event.restartCount } : s)),
          );
          break;
        case "service:installed":
        case "service:uninstalled":
          void refresh();
          break;
      }
    }

    void attach();
    return () => controller.abort();
  }, [refresh]);

  const runAction = useCallback(async (id: string, action: ServiceAction) => {
    setBusy((prev) => ({ ...prev, [id]: true }));
    try {
      await fetch(`/api/services/${encodeURIComponent(id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, reason: action === "restart" ? "Manual restart from Settings" : undefined }),
      });
    } finally {
      setBusy((prev) => ({ ...prev, [id]: false }));
    }
  }, []);

  if (loading) return <p className="text-xs text-white/40">Loading services…</p>;

  return (
    <div>
      <h2 className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-white/40">Services</h2>
      {services.length === 0 ? (
        <div className="px-2 py-4 text-center">
          <p className="text-xs text-white/40">No services installed.</p>
        </div>
      ) : (
        <div className="p-2 pt-0">
          {services.map((service) => (
            <ServiceCard
              key={service.id}
              service={service}
              busy={busy[service.id]}
              isSelected={selected?.id === service.id}
              onAction={(action) => void runAction(service.id, action)}
              onOpenConfig={() => onOpenConfig(service.id)}
              onOpenLogs={() => onOpenLogs(service.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
