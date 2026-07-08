"use client";

import { useMemo, useState } from "react";
import { useIntegrations } from "./integrations/useIntegrations";
import { IntegrationsBreadcrumb, type BreadcrumbCrumb } from "./integrations/IntegrationsBreadcrumb";
import { IntegrationListView } from "./integrations/IntegrationListView";
import { IntegrationDetailView } from "./integrations/IntegrationDetailView";
import { ServiceConfigView } from "./integrations/ServiceConfigView";
import { TelegramDetailView } from "./integrations/TelegramDetailView";

// The Integrations settings tab. Drill-down navigation:
//   list  → detail (per-integration) → service config
// State is local — no route change — matching the master/detail flow in
// specs/user-specs/integrations-framework/mockup-drilldown.html.
type View =
  | { name: "list" }
  | { name: "detail"; integrationId: string }
  | { name: "config"; integrationId: string; serviceId: string };

export function IntegrationsTab() {
  const { items, adapters, loading, error, refresh, patch, disconnect } = useIntegrations();
  const [view, setView] = useState<View>({ name: "list" });

  const currentItem = useMemo(() => {
    if (view.name === "list") return undefined;
    return items.find((i) => i.manifest.id === view.integrationId);
  }, [items, view]);

  const currentService = useMemo(() => {
    if (view.name !== "config" || !currentItem) return undefined;
    return currentItem.manifest.services.find((s) => s.id === view.serviceId);
  }, [currentItem, view]);

  const crumbs: BreadcrumbCrumb[] = [{ label: "Integrations", onClick: () => setView({ name: "list" }) }];
  if (view.name === "detail" && currentItem) {
    crumbs.push({ label: currentItem.manifest.name });
  } else if (view.name === "config" && currentItem) {
    crumbs.push({
      label: currentItem.manifest.name,
      onClick: () => setView({ name: "detail", integrationId: currentItem.manifest.id }),
    });
    if (currentService) crumbs.push({ label: currentService.name });
  }

  return (
    <div className="space-y-3">
      <IntegrationsBreadcrumb crumbs={crumbs} />
      {view.name === "list" && (
        <IntegrationListView
          items={items}
          loading={loading}
          error={error}
          onSelect={(id) => setView({ name: "detail", integrationId: id })}
        />
      )}
      {view.name === "detail" && currentItem && currentItem.manifest.id === "telegram" && (
        <TelegramDetailView
          item={currentItem}
          onOpenService={(sid) =>
            setView({ name: "config", integrationId: currentItem.manifest.id, serviceId: sid })
          }
          onRefresh={refresh}
        />
      )}
      {view.name === "detail" && currentItem && currentItem.manifest.id !== "telegram" && (
        <IntegrationDetailView
          item={currentItem}
          onOpenService={(sid) =>
            setView({ name: "config", integrationId: currentItem.manifest.id, serviceId: sid })
          }
          onRefresh={refresh}
          onDisconnect={disconnect}
        />
      )}
      {view.name === "detail" && !currentItem && !loading && (
        <p className="text-xs text-white/40">Integration not found. Return to the list.</p>
      )}
      {view.name === "config" && currentItem && (
        <ServiceConfigView
          item={currentItem}
          serviceId={view.serviceId}
          onPatch={patch}
          adapters={adapters}
        />
      )}
    </div>
  );
}
