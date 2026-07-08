"use client";

import type { ReactNode } from "react";

/**
 * Presentational grouping wrapper for a cluster of scope toggles. Used by
 * `ServiceConfigView` so future services (Calendar / Contacts / …) can
 * visually organise scopes into labelled sub-sections.
 */
export interface ScopeGroupProps {
  title: string;
  description?: string;
  children: ReactNode;
}

export function ScopeGroup({ title, description, children }: ScopeGroupProps) {
  return (
    <section className="space-y-1.5">
      <div>
        <h5 className="text-[11px] font-semibold uppercase tracking-wide text-white/50">
          {title}
        </h5>
        {description && (
          <p className="mt-0.5 text-[11px] text-white/40">{description}</p>
        )}
      </div>
      <div className="space-y-1.5">{children}</div>
    </section>
  );
}
