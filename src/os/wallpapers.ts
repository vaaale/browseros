import type { WallpaperFit } from "./types";

export interface Wallpaper {
  id: string;
  name: string;
  /** A CSS value usable as the `background` shorthand. */
  css: string;
}

export const WALLPAPERS: Wallpaper[] = [
  { id: "aurora", name: "Aurora", css: "linear-gradient(135deg,#0f2027 0%,#203a43 50%,#2c5364 100%)" },
  { id: "dusk", name: "Dusk", css: "linear-gradient(135deg,#41295a 0%,#2f0743 100%)" },
  { id: "sunset", name: "Sunset", css: "linear-gradient(135deg,#ff512f 0%,#dd2476 100%)" },
  { id: "ocean", name: "Ocean", css: "linear-gradient(135deg,#2193b0 0%,#6dd5ed 100%)" },
  { id: "forest", name: "Forest", css: "linear-gradient(135deg,#134e5e 0%,#71b280 100%)" },
  { id: "graphite", name: "Graphite", css: "linear-gradient(135deg,#1f1c2c 0%,#928dab 100%)" },
  { id: "mono", name: "Mono", css: "#0b0d12" },
];

export const DEFAULT_WALLPAPER = WALLPAPERS[0].id;

function isImageRef(value: string): boolean {
  return value.startsWith("/") || value.startsWith("http://") || value.startsWith("https://") || value.startsWith("data:");
}

/** Resolve a wallpaper setting into a CSS `background` value. */
export function wallpaperToCss(wallpaper: string, fit: WallpaperFit = "cover"): string {
  const preset = WALLPAPERS.find((w) => w.id === wallpaper);
  if (preset) return preset.css;
  if (isImageRef(wallpaper)) {
    const size = fit === "contain" ? "contain" : "cover";
    const url = wallpaper.startsWith("/") && !wallpaper.startsWith("/api/")
      ? `/api/fs/raw?path=${encodeURIComponent(wallpaper)}`
      : wallpaper;
    return `#0b0d12 url("${url}") center / ${size} no-repeat`;
  }
  return WALLPAPERS[0].css;
}
