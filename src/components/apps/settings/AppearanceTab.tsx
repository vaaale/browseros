"use client";

import { useState } from "react";
import { Check } from "lucide-react";
import { WALLPAPERS, wallpaperToCss } from "@/os/wallpapers";
import { CHAT_FONTS, CHAT_FONT_SIZES, chatFontCss } from "@/os/chat-fonts";
import type { OSSettings } from "@/os/types";
import { useOSStore } from "@/store/os-provider";
import { settingsClient } from "@/lib/os-client";

export function AppearanceTab() {
  const settings = useOSStore((s) => s.settings);
  const applySettings = useOSStore((s) => s.applySettings);
  const [imageUrl, setImageUrl] = useState("");

  const apply = (patch: Partial<OSSettings>) => {
    applySettings(patch);
    void settingsClient.patch(patch);
  };

  return (
    <div className="space-y-5">
      <div>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-white/50">Wallpaper</h3>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-3">
          {WALLPAPERS.map((w) => {
            const active = settings.wallpaper === w.id;
            return (
              <button
                key={w.id}
                onClick={() => apply({ wallpaper: w.id })}
                className={`relative h-20 overflow-hidden rounded-lg border transition-all ${active ? "border-white ring-2 ring-white/40" : "border-white/10 hover:border-white/30"}`}
                style={{ background: w.css }}
                title={w.name}
              >
                {active && (
                  <span className="absolute right-1 top-1 rounded-full bg-black/60 p-0.5">
                    <Check size={12} />
                  </span>
                )}
                <span className="absolute bottom-1 left-2 text-[11px] font-medium drop-shadow">{w.name}</span>
              </button>
            );
          })}
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <input
            value={imageUrl}
            onChange={(e) => setImageUrl(e.target.value)}
            placeholder="Image URL or VFS path (/Pictures/bg.png)"
            className="min-w-0 flex-1 rounded border border-white/10 bg-black/30 px-2 py-1.5 text-xs outline-none focus:border-white/30"
          />
          <button
            onClick={() => imageUrl.trim() && apply({ wallpaper: imageUrl.trim() })}
            className="rounded bg-white/10 px-3 py-1.5 text-xs hover:bg-white/20"
          >
            Use image
          </button>
        </div>

        <div className="mt-3 flex items-center gap-4 text-xs text-white/70">
          <span>Fit:</span>
          {(["cover", "contain"] as const).map((fit) => (
            <label key={fit} className="flex cursor-pointer items-center gap-1">
              <input type="radio" name="fit" checked={settings.wallpaperFit === fit} onChange={() => apply({ wallpaperFit: fit })} />
              {fit}
            </label>
          ))}
        </div>
      </div>

      <div>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-white/50">Accent</h3>
        <input
          type="color"
          value={settings.accent}
          onChange={(e) => apply({ accent: e.target.value })}
          className="h-8 w-16 cursor-pointer rounded border border-white/10 bg-transparent"
        />
      </div>

      <div>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-white/50">Chat text</h3>
        <div className="flex flex-wrap items-center gap-4 text-xs text-white/70">
          <label className="flex items-center gap-2">
            <span>Font</span>
            <select
              value={settings.chatFont ?? "system"}
              onChange={(e) => apply({ chatFont: e.target.value })}
              className="rounded border border-white/10 bg-black/30 px-2 py-1 text-xs text-white outline-none focus:border-white/30"
            >
              {CHAT_FONTS.map((f) => (
                <option key={f.id} value={f.id} className="bg-neutral-900">
                  {f.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2">
            <span>Size</span>
            <select
              value={settings.chatFontSize ?? 15}
              onChange={(e) => apply({ chatFontSize: Number(e.target.value) })}
              className="rounded border border-white/10 bg-black/30 px-2 py-1 text-xs text-white outline-none focus:border-white/30"
            >
              {CHAT_FONT_SIZES.map((s) => (
                <option key={s} value={s} className="bg-neutral-900">
                  {s}px
                </option>
              ))}
            </select>
          </label>
        </div>
        <div
          className="mt-3 rounded-lg border border-white/10 bg-black/20 p-3 text-white/85"
          style={{ fontFamily: chatFontCss(settings.chatFont ?? "system"), fontSize: `${settings.chatFontSize ?? 15}px` }}
        >
          The quick brown fox jumps over the lazy dog. Code and other blocks are shown with syntax highlighting in a monospace font.
        </div>
      </div>

      <div
        className="flex h-24 items-center justify-center rounded-xl border border-white/10 text-xs text-white/70"
        style={{ background: wallpaperToCss(settings.wallpaper, settings.wallpaperFit) }}
      >
        Live preview
      </div>
    </div>
  );
}
