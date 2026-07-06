"use client";

import { Bot, ChevronRight, Zap } from "lucide-react";
import type { IntegrationSummary } from "./useIntegrations";
import { TelegramBotAuthSection } from "./TelegramBotAuthSection";

// Telegram-specific detail view. Replaces the generic OAuth flow used by
// GSuite because Telegram bots authenticate with a single token pasted from
// @BotFather — no popup, no client_secrets upload. The auth card is factored
// into TelegramBotAuthSection; this view composes it with the standard
// services list (Bot / User).

export interface TelegramDetailViewProps {
  item: IntegrationSummary;
  onOpenService: (serviceId: string) => void;
  onRefresh: () => Promise<void>;
}

export function TelegramDetailView({ item, onOpenService, onRefresh }: TelegramDetailViewProps) {
  return (
    <div className="space-y-4">
      <TelegramBotAuthSection onChange={onRefresh} />

      <section>
        <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-white/40">
          Services
        </h4>
        <div className="overflow-hidden rounded-lg border border-white/10 bg-white/[0.03]">
          {item.manifest.services.map((svc) => {
            const svcState = item.state.services[svc.id];
            const isStub = svc.id === "user";
            return (
              <button
                key={svc.id}
                type="button"
                onClick={() => onOpenService(svc.id)}
                className="flex w-full items-center justify-between border-b border-white/5 px-4 py-3 text-left transition-colors last:border-b-0 hover:bg-white/10"
              >
                <div className="flex items-center gap-3">
                  {svc.id === "bot" ? (
                    <Bot size={14} className="text-white/50" />
                  ) : (
                    <Zap size={14} className="text-white/50" />
                  )}
                  <div>
                    <div className="flex items-center gap-2 text-[13px] font-medium">
                      {svc.name}
                      {isStub && (
                        <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] font-normal text-white/50">
                          Phase 2
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] text-white/50">{svc.description}</div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span
                    className={`text-[11px] ${
                      svcState?.enabled === false ? "text-white/40" : "text-emerald-300"
                    }`}
                  >
                    {svcState?.enabled === false ? "Disabled" : "Enabled"}
                  </span>
                  <ChevronRight size={16} className="text-white/30" />
                </div>
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
}
