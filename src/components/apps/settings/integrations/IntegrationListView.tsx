"use client";

import { ChevronRight, Plug } from "lucide-react";
import type { IntegrationSummary } from "./useIntegrations";

type Status = "connected" | "partial" | "disconnected";

function integrationStatus(item: IntegrationSummary): Status {
  const { state, manifest } = item;
  if (!state.connected) return "disconnected";
  const anyErrored = manifest.services.some((s) => state.services[s.id]?.error);
  const anyDisabled = manifest.services.some((s) => state.services[s.id]?.enabled === false);
  if (anyErrored || anyDisabled) return "partial";
  return "connected";
}

function serviceSummary(item: IntegrationSummary): string {
  const enabled = item.manifest.services.filter((s) => item.state.services[s.id]?.enabled !== false).length;
  const total = item.manifest.services.length;
  return `${enabled}/${total} services enabled`;
}

const STATUS_STYLES: Record<Status, string> = {
  connected: "bg-emerald-400",
  partial: "bg-amber-400",
  disconnected: "bg-white/25",
};

export interface IntegrationListViewProps {
  items: IntegrationSummary[];
  loading: boolean;
  error?: string;
  onSelect: (id: string) => void;
}

export function IntegrationListView({ items, loading, error, onSelect }: IntegrationListViewProps) {
  if (loading && items.length === 0) return <p className="text-xs text-white/40">Loading integrations…</p>;
  if (error) return <p className="text-xs text-red-300">Error: {error}</p>;
  if (items.length === 0) return <p className="text-xs text-white/40">No integrations registered.</p>;

  return (
    <div className="overflow-hidden rounded-lg border border-white/10 bg-white/[0.05]">
      <div className="border-b border-white/10 px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-white/40">
        Available integrations
      </div>
      {items.map((item) => {
        const status = integrationStatus(item);
        return (
          <button
            key={item.manifest.id}
            type="button"
            onClick={() => onSelect(item.manifest.id)}
            className="flex w-full items-center justify-between border-b border-white/5 px-4 py-3 text-left transition-colors last:border-b-0 hover:bg-white/10"
          >
            <div className="flex items-center gap-3">
              <span className={`inline-block h-2 w-2 rounded-full ${STATUS_STYLES[status]}`} />
              <Plug size={14} className="text-white/50" />
              <div>
                <div className="text-[13px] font-medium">{item.manifest.name}</div>
                <div className="text-[11px] text-white/50">{serviceSummary(item)}</div>
              </div>
            </div>
            <ChevronRight size={16} className="text-white/30" />
          </button>
        );
      })}
    </div>
  );
}
