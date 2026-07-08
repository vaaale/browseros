# BOS UI Style Guide

How to build UI that looks and behaves like the rest of BrowserOS. This guide
documents the conventions **already baked into the codebase** — follow them so an
agent-built screen is indistinguishable from a hand-built one. When in doubt,
open a neighbouring component and copy its patterns rather than inventing new ones.

Related reading: [Design heuristics & gotchas](../design-heuristics.md) (hard
rules on SSR/hydration, the VFS, atomic writes), [Built-in apps](../apps/built-in-apps.md).

---

## 1. The stack (what you have, what you don't)

- **Tailwind CSS v4** (PostCSS, imported via `@import "tailwindcss";` in
  `src/app/globals.css`). No `tailwind.config.js` — configure through CSS
  (`@theme inline`) if you must.
- **lucide-react** for all icons.
- **Geist Sans / Geist Mono** fonts, wired in `src/app/layout.tsx` and exposed as
  `--font-sans` / `--font-mono`.
- **Zustand** for OS state (`src/store/os-store.ts` via `useOSStore`).

**There is no component library.** No shadcn/ui, no Radix, no `cn()` helper. Every
button, input, modal, and tab is plain JSX + Tailwind utility strings written
inline. Don't add a UI dependency or a class-merging helper to build a screen —
match the existing inline style. If you find yourself repeating a complex class
string 3+ times *within one file*, extract a small local component (see
`FieldRow` in `ConfigForm.tsx`), not a shared design-system package.

---

## 2. Dark theme + the opacity palette

BOS is **dark-only** (`color-scheme: dark` in `globals.css`). There is no light
mode and no theme toggle — do not add `dark:` variants or light fallbacks.

Colour is expressed almost entirely as **white/black at fractional opacity**, not
named grays. This is the single most important visual convention. Learn the scale:

| Purpose | Class |
| --- | --- |
| Primary text | `text-white` / `text-white/90` |
| Secondary text, labels | `text-white/60` / `text-white/70` |
| Muted / hint text | `text-white/40` / `text-white/50` |
| Subtle surface (cards, navs) | `bg-white/5` |
| Hover surface | `hover:bg-white/10` / `hover:bg-white/15` |
| Active / selected surface | `bg-white/15` |
| Borders / dividers | `border-white/10` (default), `focus:border-white/30` |
| Deep panel / input field | `bg-black/30` |
| Modal scrim | `bg-black/60` |

**Accent colours** are used sparingly and semantically — never for decoration:

- **violet** (`text-violet-300`, `bg-violet-500/30`) — agent / assistant surfaces.
- **amber** (`text-amber-100`, `bg-amber-400/10`, `border-amber-400/20`) — warnings
  and "needs attention" banners.
- **sky / emerald** — informational / success accents.
- The macOS traffic-light hex values (`#ff5f57`, `#febc2e`, `#28c840`) belong to
  window chrome only; don't reuse them elsewhere.

Prefer an opacity utility over a hardcoded hex. Reserve raw hex (e.g. the window
backgrounds `#15171e` / `#0f1117`) for chrome that already uses them.

---

## 3. Anatomy of a built-in app

A built-in app is a self-describing folder `src/apps/<id>/` with two files,
auto-discovered by `tools/gen-apps.mjs` (no central registry to edit).

**`manifest.ts`** — metadata only:

```typescript
import type { AppManifest } from "@/os/types";

const manifest: AppManifest = {
  id: "chat",
  name: "Assistant",
  icon: "Bot",          // must be a key in src/components/desktop/icons.tsx
  defaultWidth: 880,
  defaultHeight: 640,
  order: 30,            // dock/list sort key; lower = earlier
  singleton: true,      // at most one window
  builtin: true,
};

export default manifest;
```

**`index.tsx`** — the component. Always `"use client"`, always receives
`AppProps` (`{ windowId, appId, params? }` from `src/components/apps/types.ts`),
and **always fills its window** with a flex column:

```tsx
"use client";

import type { AppProps } from "@/components/apps/types";
import { useOSStore } from "@/store/os-provider";

export default function MyApp({ windowId }: AppProps) {
  const launch = useOSStore((s) => s.launch);

  return (
    <div className="flex h-full flex-col">
      {/* optional toolbar / header — shrink-0 */}
      <div className="flex shrink-0 items-center gap-1 border-b border-white/10 bg-white/5 px-2 py-1.5">
        {/* actions */}
      </div>
      {/* scrollable body — min-h-0 flex-1 is REQUIRED for scroll to work */}
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {/* content */}
      </div>
    </div>
  );
}
```

The `min-h-0 flex-1` on the scroll region is not optional cosmetics — without
`min-h-0` a flex child won't shrink and the scrollbar breaks. This is the single
most common layout mistake.

---

## 4. Component recipes (copy these)

These are the exact patterns used across the Settings app, Files, Chat, etc.
Reproduce them verbatim rather than approximating.

### Button

```tsx
<button className="rounded bg-white/10 px-3 py-1.5 text-xs hover:bg-white/20 disabled:opacity-40">
  Save
</button>
```

Icon-only button (toolbars):

```tsx
<button className="rounded p-1.5 hover:bg-white/10 disabled:opacity-30">
  <ArrowUp size={16} />
</button>
```

Accent button (warning/CTA), amber shown:

```tsx
<button className="rounded bg-amber-400/20 px-2 py-1 text-xs font-medium hover:bg-amber-400/30">
  Open Settings
</button>
```

### Text input / select / textarea

One canonical field class for all three:

```tsx
<input
  className="rounded border border-white/10 bg-black/30 px-2 py-1.5 text-xs outline-none focus:border-white/30"
/>
```

Label + field rows use a two-column grid:

```tsx
<div className="grid grid-cols-[140px_1fr] items-center gap-2">
  <label className="text-xs text-white/60">Provider</label>
  {/* field */}
</div>
```

See `src/components/apps/settings/ConfigForm.tsx` for the full form + save flow
(fetch `PATCH`, `saving` state, inline status text).

### Modal / dialog

Fixed full-screen scrim + centred panel, high z-index, backdrop blur:

```tsx
<div className="fixed inset-0 z-[200000] flex items-center justify-center bg-black/60 backdrop-blur-sm">
  <div className="w-[460px] max-w-[92vw] rounded-2xl border border-white/10 bg-[#15171e] p-6 text-sm shadow-2xl">
    {/* content */}
  </div>
</div>
```

### Sidebar / vertical tabs (Settings pattern)

```tsx
<nav className="w-44 shrink-0 overflow-auto border-r border-white/10 bg-white/[0.02] p-2">
  <h2 className="px-2 py-1 text-xs font-semibold uppercase tracking-wide text-white/40">Settings</h2>
  {items.map((it) => (
    <button
      key={it.id}
      onClick={() => setActive(it.id)}
      className={`mt-0.5 block w-full truncate rounded px-2 py-1.5 text-left text-xs transition-colors ${
        active === it.id ? "bg-white/15 text-white" : "text-white/70 hover:bg-white/10"
      }`}
    >
      {it.title}
    </button>
  ))}
</nav>
```

The selected/unselected className ternary is the standard way to express active
state — there is no variant abstraction.

### Section header

```tsx
<h3 className="text-xs font-semibold uppercase tracking-wide text-white/50">Recent</h3>
```

### Warning / info banner

```tsx
<div className="flex shrink-0 items-center gap-2 border-b border-amber-400/20 bg-amber-400/10 px-3 py-2 text-xs text-amber-100">
  <AlertTriangle size={14} className="shrink-0" />
  <span className="flex-1">No API key set.</span>
</div>
```

### Card / list grid

```tsx
<div className="grid auto-rows-min grid-cols-[repeat(auto-fill,minmax(96px,1fr))] gap-1 overflow-auto p-3">
  {items.map((x) => (
    <div key={x.id} className="group relative flex flex-col items-center gap-1 rounded-lg p-2 hover:bg-white/10">
      {/* item */}
    </div>
  ))}
</div>
```

---

## 5. Icons

Use **lucide-react**. Two ways to reference:

- **In manifests / data**: by string name, resolved through
  `src/components/desktop/icons.tsx`. The string **must** be a key in that file's
  `ICONS` map — if you need a new icon, add the import there first (otherwise it
  falls back to `HelpCircle`). Render with `<AppIcon name={app.icon} size={24} />`.
- **In component code**: import the icon directly
  (`import { AlertTriangle } from "lucide-react"`) and render `<AlertTriangle size={14} />`.

Conventions:

- Size via the `size` prop (numbers, not classes): common values `12`–`18` for
  inline/toolbar UI, `24`+ for app/dock icons.
- Default `strokeWidth` around `1.75`; bump to `2` for small/dense contexts.
- Add `className="shrink-0"` to icons inside flex rows so they don't get squeezed.

---

## 6. Typography, spacing, shape

- **Font size**: `text-xs` (12px) is the *default* for chrome, labels, and most
  controls — BOS UI is deliberately dense. `text-sm` (14px) for readable app body
  content. Larger sizes are rare; reserve for prominent headings.
- **Weight**: regular by default; `font-medium` for buttons/emphasis;
  `font-semibold` for section/nav headers. Use `uppercase tracking-wide` on small
  section labels.
- **Mono**: `font-mono` for code, IDs, paths, hashes.
- **Spacing**: tight. `gap-1`/`gap-1.5`/`gap-2` dominate; `gap-3` for looser
  groupings; `gap-4`+ is uncommon. Inputs pad `px-2 py-1.5`; buttons `px-3 py-1.5`.
  Use `space-y-3` to stack form sections.
- **Radius**: `rounded` for controls, `rounded-lg`/`rounded-xl` for icons and
  panels, `rounded-2xl` for modals and the dock.
- **Shadow**: `shadow-2xl` for floating chrome (windows, modals, dock, topbar).
  Body content is generally flat.
- **Glass**: `backdrop-blur-sm|md|xl` on chrome/overlays over `bg-black/30` for the
  frosted look.
- **Transitions**: `transition-colors` on interactive elements; `transition-all`
  for hover-lift (`hover:-translate-y-1` on dock items).

---

## 7. Interaction & selection

- Mark **all interactive components** `"use client";`. Server components are only
  for SSR seeding (`layout.tsx`, `page.tsx`). See
  [Design heuristics → Server vs. client](../design-heuristics.md).
- **Don't introduce client-only initial state** — the first client render must
  match SSR markup or hydration tests fail. Fetch dynamic data in `useEffect`
  after mount, not during render (see the API-key check in `src/apps/chat/index.tsx`).
- Read OS state with a **selector**: `useOSStore((s) => s.launch)`, never grab the
  whole store. Mutations go through store actions (`launch`, `close`, `focus`,
  `setTitle`, `applySettings`, …).
- Apps that show dynamic context should set their window title via
  `useOSStore((s) => s.setTitle)(windowId, title)`.
- **Desktop chrome** (dock, topbar, titlebars, desktop icons) uses `select-none`;
  app *content* stays selectable — don't blanket `select-none` an app body.
- Reveal-on-hover uses the `group` / `group-hover:` pattern; overlaid hover labels
  get `pointer-events-none`.

---

## 8. Checklist before you call a screen done

- [ ] Root is `flex h-full flex-col`; scroll region has `min-h-0 flex-1 overflow-auto`.
- [ ] Colours use the white/black opacity scale; accents only where semantic.
- [ ] Controls match the canonical button/input recipes (§4).
- [ ] `text-xs` default sizing; dense spacing (`gap-1`–`gap-2`).
- [ ] Icons from lucide-react; new manifest icons registered in `icons.tsx`.
- [ ] `"use client"` on interactive components; no client-only initial state.
- [ ] OS state accessed via `useOSStore` selectors.
- [ ] No new UI library, no `cn()` helper, no light-mode variants introduced.
- [ ] `npx tsc --noEmit` and `npm run lint` pass.
