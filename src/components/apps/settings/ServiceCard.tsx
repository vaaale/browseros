"use client";

import { Play, Square, RotateCcw, Settings2, FileText, ExternalLink } from "lucide-react";
import type { ServiceState, ServiceStatusView } from "@/core/service/types";

const STATE_STYLES: Record<ServiceState, { dot: string; label: string; text: string }> = {
  running: { dot: "bg-green-400", label: "Running", text: "text-green-300" },
  stopped: { dot: "bg-white/30", label: "Stopped", text: "text-white/50" },
  restarting: { dot: "bg-yellow-400 animate-pulse", label: "Restarting", text: "text-yellow-300" },
  crashed: { dot: "bg-red-400", label: "Crashed", text: "text-red-300" },
  corrupted: { dot: "bg-orange-400", label: "Corrupted", text: "text-orange-300" },
};

export type ServiceAction = "start" | "stop" | "restart";

export interface ServiceCardProps {
  service: ServiceStatusView;
  /** True while a start/stop/restart request for this service is in flight. */
  busy?: boolean;
  isSelected?: boolean;
  onAction: (action: ServiceAction) => void;
  onOpenConfig: () => void;
  onOpenLogs: () => void;
}

export function ServiceCard({ service, busy, isSelected, onAction, onOpenConfig, onOpenLogs }: ServiceCardProps) {
  const style = STATE_STYLES[service.state];
  const corrupted = service.state === "corrupted";
  const canStart = !busy && !corrupted && (service.state === "stopped" || service.state === "crashed");
  const canStop = !busy && !corrupted && (service.state === "running" || service.state === "restarting");
  const canRestart = !busy && !corrupted && service.state === "running";

  return (
    <div
      className={`mb-1 rounded-md border p-2 transition-colors ${
        isSelected ? "border-violet-500/70 bg-white/10" : "border-transparent hover:border-white/20 hover:bg-white/5"
      }`}
    >
      <div className="mb-1 flex items-center gap-2">
        <span className={`h-2 w-2 shrink-0 rounded-full ${style.dot}`} />
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-white">{service.manifest.name}</span>
        <span className={`shrink-0 text-[9px] font-semibold uppercase tracking-wide ${style.text}`}>{style.label}</span>
      </div>
      <p className="mb-1.5 truncate text-[11px] text-white/40">
        v{service.manifest.version}
        {service.boundHost && service.boundPort != null && (
          <>
            {" "}
            · {service.boundHost}:{service.boundPort}
          </>
        )}
        {service.restartCount > 0 && (
          <>
            {" "}
            · {service.restartCount} restart{service.restartCount === 1 ? "" : "s"}
          </>
        )}
      </p>
      {(service.corruptedReason || service.lastError) && (
        <p className="mb-1.5 rounded bg-orange-500/10 px-1.5 py-1 text-[10px] leading-snug text-orange-300">
          {service.corruptedReason || service.lastError}
        </p>
      )}
      <div className="flex items-center gap-1">
        <button
          onClick={() => onAction("start")}
          disabled={!canStart}
          title="Start"
          className="rounded p-1 text-green-300 transition-colors hover:bg-green-500/20 disabled:cursor-not-allowed disabled:opacity-30"
        >
          <Play size={11} />
        </button>
        <button
          onClick={() => onAction("stop")}
          disabled={!canStop}
          title="Stop"
          className="rounded p-1 text-white/60 transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-30"
        >
          <Square size={11} />
        </button>
        <button
          onClick={() => onAction("restart")}
          disabled={!canRestart}
          title="Restart"
          className="rounded p-1 text-yellow-300 transition-colors hover:bg-yellow-500/20 disabled:cursor-not-allowed disabled:opacity-30"
        >
          <RotateCcw size={11} />
        </button>
        <span className="flex-1" />
        <button
          onClick={onOpenConfig}
          title="Config"
          className="rounded p-1 text-white/60 transition-colors hover:bg-white/10"
        >
          <Settings2 size={11} />
        </button>
        <button
          onClick={onOpenLogs}
          title="Logs"
          className="rounded p-1 text-white/60 transition-colors hover:bg-white/10"
        >
          <FileText size={11} />
        </button>
        <button
          onClick={() => window.open(`/apps/${encodeURIComponent(service.id)}/`, "_blank")}
          title="Open App (if this service bundles one — 404 otherwise)"
          className="rounded p-1 text-white/60 transition-colors hover:bg-white/10"
        >
          <ExternalLink size={11} />
        </button>
      </div>
    </div>
  );
}
