"use client";

import { useMemo, useState, type ReactNode } from "react";

// Shared collapsible tool-group list (041-tool-groups, FR-043/FR-044/FR-048).
//
// This replaces TWO copies of the same `groupByCategory` helper — one in
// ToolsTab.tsx, one in assistant/ToolAccordions.tsx — which had drifted into
// separate implementations of the same idea.
//
// Both copies also coerced a missing group into a `"General"` bucket. That
// coercion is deliberately NOT carried forward: `group` is now a group ID, so
// an unresolvable one means a capability points at a group that doesn't exist —
// a bug to surface, not to absorb into a phantom heading. There is no fallback
// group anywhere in the system (FR-041), and `unresolved` below is how this
// component says so.

export interface GroupedItem {
  id: string;
  /** Group ID (a slug), not a display name. */
  group: string;
}

export interface GroupMeta {
  id: string;
  name: string;
  description?: string;
}

export interface ToolGroupSection<T> {
  group: GroupMeta;
  items: T[];
}

/**
 * Bucket items by group id, ordered by the CANONICAL group order the caller
 * passes in (the group table's order — built-ins first, dynamic groups after),
 * not by first-seen item order.
 *
 * Items whose group id doesn't resolve are returned separately in `unresolved`
 * rather than silently bucketed.
 */
export function groupItems<T extends GroupedItem>(
  items: T[],
  groups: GroupMeta[],
): { sections: ToolGroupSection<T>[]; unresolved: T[] } {
  const byId = new Map(groups.map((g) => [g.id, g]));
  const buckets = new Map<string, T[]>();
  const unresolved: T[] = [];
  for (const item of items) {
    if (!byId.has(item.group)) {
      unresolved.push(item);
      continue;
    }
    const bucket = buckets.get(item.group) ?? [];
    bucket.push(item);
    buckets.set(item.group, bucket);
  }
  const sections = groups
    .filter((g) => buckets.has(g.id))
    .map((group) => ({ group, items: buckets.get(group.id)! }));
  return { sections, unresolved };
}

function Chevron({ open }: { open: boolean }) {
  return (
    <span
      aria-hidden
      className={`inline-block shrink-0 text-[10px] text-white/40 transition-transform ${open ? "rotate-90" : ""}`}
    >
      ▶
    </span>
  );
}

export interface ToolGroupListProps<T extends GroupedItem> {
  items: T[];
  groups: GroupMeta[];
  /** Rendered inside an expanded group, below any header extras. */
  renderItems: (items: T[], group: GroupMeta) => ReactNode;
  /** Optional controls on the group header row (e.g. Toggle All / Clear All). */
  renderHeaderActions?: (items: T[], group: GroupMeta) => ReactNode;
  /** Optional block between the header and the items (e.g. the group editor). */
  renderGroupDetail?: (group: GroupMeta) => ReactNode;
  /** Ids of groups to force open — used by a filter so matches are visible. */
  forceOpen?: Set<string>;
  emptyMessage?: string;
}

/** Collapsed on load (FR-043); each header shows the group's name and its tool
 *  count (FR-044); each group expands independently. */
export function ToolGroupList<T extends GroupedItem>({
  items,
  groups,
  renderItems,
  renderHeaderActions,
  renderGroupDetail,
  forceOpen,
  emptyMessage,
}: ToolGroupListProps<T>) {
  const { sections, unresolved } = useMemo(() => groupItems(items, groups), [items, groups]);
  const [openIds, setOpenIds] = useState<Set<string>>(new Set());

  const toggle = (id: string) =>
    setOpenIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  if (sections.length === 0 && unresolved.length === 0) {
    return <p className="text-xs text-white/40">{emptyMessage ?? "Nothing to show."}</p>;
  }

  return (
    <div className="flex flex-col gap-2">
      {sections.map(({ group, items: groupItemsForSection }) => {
        const open = forceOpen?.has(group.id) || openIds.has(group.id);
        return (
          <div key={group.id} className="rounded-md border border-white/10 bg-white/[0.03]">
            <div className="flex items-center justify-between gap-2 px-2.5 py-2">
              <button
                type="button"
                onClick={() => toggle(group.id)}
                aria-expanded={open}
                // Explicit label: without it the accessible name is the raw
                // contents — decorative chevron included, and the display name
                // in its DOM casing rather than the uppercase the user sees.
                aria-label={`${group.name}, ${groupItemsForSection.length} tool${groupItemsForSection.length === 1 ? "" : "s"}`}
                className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
              >
                <Chevron open={open} />
                <span className="text-[11px] font-semibold uppercase tracking-wide text-violet-300">{group.name}</span>
                <span className="text-[10px] text-white/40">{groupItemsForSection.length}</span>
              </button>
              {renderHeaderActions?.(groupItemsForSection, group)}
            </div>
            {open && (
              <div className="border-t border-white/10 px-2.5 py-2">
                {renderGroupDetail?.(group)}
                {renderItems(groupItemsForSection, group)}
              </div>
            )}
          </div>
        );
      })}

      {unresolved.length > 0 && (
        // Loud, not silent: these tools name a group that does not exist. The
        // old "General" bucket used to hide exactly this.
        <div className="rounded-md border border-red-400/40 bg-red-500/10 p-2.5">
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-red-300">
            Unresolved tool group
          </div>
          <p className="mb-1.5 text-[11px] leading-snug text-white/70">
            {unresolved.length} tool{unresolved.length === 1 ? "" : "s"} point at a tool group that no longer exists.
            This is a bug in whatever registered them — a marketplace item whose manifest declares a different group id,
            or a stale capability. They are shown here rather than filed under a placeholder.
          </p>
          <ul className="flex flex-col gap-0.5">
            {unresolved.map((t) => (
              <li key={t.id} className="font-mono text-[11px] text-white/80">
                {t.id} <span className="text-white/40">→ {t.group || "(no group)"}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
