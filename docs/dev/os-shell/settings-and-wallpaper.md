# OS shell: settings & wallpaper

## OS settings (`src/os/settings.ts`)

`OSSettings` (`src/os/types.ts`):

```ts
interface OSSettings {
  wallpaper: string;                 // preset id, image URL, or VFS path
  wallpaperFit: "cover" | "contain";
  accent: string;                    // hex
  theme: "dark" | "light";
}
```

Stored at `data/settings.json`. `getSettings()` / `updateSettings(patch)` are
server‑only. Reached from the client via `/api/settings` (GET, PATCH) and the
`settingsClient` helper in `src/lib/os-client.ts`.

The OS store also keeps `settings` for live UI; `applySettings(patch)` updates the
store, and you persist separately with `settingsClient.patch(...)`. The
[Appearance config tab](../configuration/configuration-system.md) (`appearance`
namespace) `load`/`save` delegate to `getSettings`/`updateSettings`, so changing
appearance via the config API or the assistant goes through the same store.

---

## Wallpapers (`src/os/wallpapers.ts`)

Holds the built‑in gradient **presets** and `wallpaperToCss(settings)`, which turns
a `wallpaper` value into a CSS background:

- a **preset id** → its gradient,
- an **http(s) URL** → an image background,
- a **VFS path** → served via `/api/fs/raw?path=…`.

`wallpaperFit` maps to `background-size: cover|contain`.

The Files app can set a wallpaper directly (`applySettings({ wallpaper })` +
`settingsClient.patch`). See the user page
[Appearance](../../usage/settings/appearance.md).
