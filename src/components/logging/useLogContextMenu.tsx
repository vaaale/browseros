"use client";

import { useEffect, useState } from "react";

// Shared right-click "Copy" context menu for log record rows — used by both
// the toolbar's recent-log popover and the Settings → Logs timeline. Copies
// the full record as pretty-printed JSON, not just its rendered summary.

interface MenuState {
  x: number;
  y: number;
  record: unknown;
}

export function useLogContextMenu(): {
  openMenu: (e: React.MouseEvent, record: unknown) => void;
  menuNode: React.ReactNode;
} {
  const [menu, setMenu] = useState<MenuState | null>(null);

  const openMenu = (e: React.MouseEvent, record: unknown) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, record });
  };
  const closeMenu = () => setMenu(null);

  useEffect(() => {
    if (!menu) return;
    const onDocClick = () => closeMenu();
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeMenu();
    };
    document.addEventListener("click", onDocClick);
    document.addEventListener("contextmenu", onDocClick);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("click", onDocClick);
      document.removeEventListener("contextmenu", onDocClick);
      document.removeEventListener("keydown", onEsc);
    };
  }, [menu]);

  const menuNode = menu ? (
    <div
      style={{ position: "fixed", left: menu.x, top: menu.y, zIndex: 100002 }}
      className="min-w-[110px] rounded border border-white/15 bg-neutral-900 py-1 text-[11px] shadow-2xl"
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard.writeText(JSON.stringify(menu.record, null, 2)).catch(() => {});
          closeMenu();
        }}
        className="block w-full px-3 py-1 text-left text-white/80 hover:bg-white/10"
      >
        Copy
      </button>
    </div>
  ) : null;

  return { openMenu, menuNode };
}
