import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { dataDir } from "./data-dir";
import { writeFileAtomic } from "./atomic-write";
import type { OSSettings } from "./types";
import { DEFAULT_WALLPAPER } from "./wallpapers";

const DATA_DIR = dataDir();
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");

export const DEFAULT_SETTINGS: OSSettings = {
  wallpaper: DEFAULT_WALLPAPER,
  wallpaperFit: "cover",
  accent: "#5b8cff",
  theme: "dark",
  chatFont: "system",
  chatFontSize: 15,
};

export async function getSettings(): Promise<OSSettings> {
  try {
    const raw = await fs.readFile(SETTINGS_FILE, "utf8");
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<OSSettings>) };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export async function updateSettings(patch: Partial<OSSettings>): Promise<OSSettings> {
  const next = { ...(await getSettings()), ...patch };
  await writeFileAtomic(SETTINGS_FILE, JSON.stringify(next, null, 2));
  return next;
}
