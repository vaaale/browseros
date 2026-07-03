"use client";

import { ChevronRight } from "lucide-react";

export interface BreadcrumbCrumb {
  label: string;
  onClick?: () => void;
}

export function IntegrationsBreadcrumb({ crumbs }: { crumbs: BreadcrumbCrumb[] }) {
  return (
    <nav aria-label="Breadcrumb" className="mb-3 flex items-center gap-1.5 text-[12px]">
      {crumbs.map((c, i) => {
        const last = i === crumbs.length - 1;
        const clickable = !!c.onClick && !last;
        return (
          <span key={i} className="flex items-center gap-1.5">
            {clickable ? (
              <button
                type="button"
                onClick={c.onClick}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    c.onClick?.();
                  }
                }}
                className="text-white/60 transition-colors hover:text-white"
              >
                {c.label}
              </button>
            ) : (
              <span className={last ? "font-medium text-white" : "text-white/60"}>{c.label}</span>
            )}
            {!last && <ChevronRight size={12} className="text-white/30" />}
          </span>
        );
      })}
    </nav>
  );
}
