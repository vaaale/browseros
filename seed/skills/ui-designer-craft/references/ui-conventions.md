# BOS App UI Conventions

Quick reference for designing and reviewing a BOS app UI. Always defer to the full [style guide](../../../docs/dev/guides/style-guide.md) for exact Tailwind recipes.

---

## 1. App or settings tab?

- **Own window** — when the user needs a persistent, focused surface (Files, Memory, Build Studio).
- **Settings tab** — when the surface is configuration for an existing subsystem (LLM providers, integrations, agents).
- **Modal / overlay** — when the interaction is short and initiated from another app.
- **Sidebar panel** — only when it is clearly secondary to a main app surface.

Avoid putting half the feature in an app window and half in a Settings tab unless the boundary is obvious to the user.

---

## 2. Window layout

Every app window root should follow this pattern:

```tsx
<div className="flex h-full flex-col" data-theme="dark">
  {/* chrome / toolbar — shrink-0 */}
  <div className="flex shrink-0 items-center ...">...</div>
  {/* scrollable body */}
  <div className="min-h-0 flex-1 overflow-auto ...">...</div>
</div>
```

`min-h-0` on the scroll region is mandatory. Without it, the flex child will not shrink and the scrollbar will not work.

---

## 3. Built-in vs installed app UI

### Built-in app

- Can use BOS OS store directly with selectors.
- Can import shared `src/components/` chrome.
- Can call `/api/...` routes.
- Should match BOS style guide exactly.

### Installed app

- Rendered in a sandboxed iframe at `/apps/<id>`.
- Same-origin, so it can call BOS APIs if permitted.
- Should still match BOS visual conventions, but has more freedom because it is isolated.
- Cannot import BOS `src/` code directly; bundle against BOS's `node_modules`.

---

## 4. Common surfaces

| Pattern | When to use | Recipe location |
|---|---|---|
| Button | Primary action | style guide §4 |
| Icon-only toolbar button | Many actions in a row | style guide §4 |
| Text input / select | Forms | style guide §4 |
| Modal / dialog | Confirmation, focused task | style guide §4 |
| Sidebar / vertical tabs | Settings-like navigation | style guide §4 |
| Card / list grid | Browsing items | style guide §4 |
| Warning banner | Needs attention | style guide §4 |

---

## 5. Configuration UI

If the app needs user settings:

1. Add a `ConfigRegistration` in `src/lib/config/registry.ts`.
2. Use the standard two-column form layout from the style guide.
3. Save on blur/change with a visible "Saving…" / "Saved" indicator.
4. Add a Settings tab only if the config needs frequent tuning; otherwise expose it inside the app.

---

## 6. Tool UI affordances

When an app exposes assistant tools:

- Provide clear, concise tool descriptions — they show up in **Settings → Agents → Tools**.
- Dangerous actions (delete, purge, promote) should require confirmation in the UI if triggered from a tool.
- Runtime surface tools should update the app window visibly (scroll to item, flash row, etc.).

---

## 7. Icons and naming

- App icon must be a key in `src/components/desktop/icons.tsx`.
- In-component icons come from `lucide-react`.
- App name should be a noun or noun phrase ("Files", "Memory", "Build Studio").
- Tool names should be prefixed with the app id (`myapp_...`).

---

## 8. Accessibility and polish

- All interactive elements must have visible focus states (`focus:border-white/30`).
- Disabled states should reduce opacity, never hide the control.
- Empty states matter: show a helpful message and a CTA.
- Errors belong near the action that caused them; use amber banners sparingly.
