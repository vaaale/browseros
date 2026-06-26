import "server-only";
import { promises as fs } from "fs";
import path from "path";
import type { OSSettings } from "./types";
import { DEFAULT_WALLPAPER } from "./wallpapers";

const DATA_DIR = path.join(process.cwd(), "data");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");

export const DEFAULT_SETTINGS: OSSettings = {
  wallpaper: DEFAULT_WALLPAPER,
  wallpaperFit: "cover",
  accent: "#5b8cff",
  theme: "dark",
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
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(SETTINGS_FILE, JSON.stringify(next, null, 2), "utf8");
  return next;
}
