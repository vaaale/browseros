# A2UI Catalog for BOS App Design

How to render and iterate on live UI mockups in the UI Preview app during the design phase of a `bos-app` session. BOS ships its OWN dark-themed A2UI v0.9 catalog (`src/apps/ui-preview/catalog.tsx`) — mockups render in BrowserOS's real visual language (violet accents, translucent dark surfaces), not the protocol's generic reference styling.

---

## 1. When to use this

Use A2UI during the **iterative UI design phase** of a `bos-app` (Phase 3 of `SKILL.md`):

- The user describes a screen or a change to one.
- You call `a2ui_render` to generate a validated envelope from that description.
- You pass the envelope straight to `ui_preview_render`.
- The user sees the mockup update in the UI Preview window.

A2UI is a **design-time mockup surface only** — it is never shipped. The Developer implements the real, final UI as React components once the spec and mockup are approved.

---

## 2. The tool flow

1. **Open (once per session)**: `ui_preview_open()` — opens or focuses the UI Preview window. Cheap to call again; it's a no-op if already open.
2. **Generate**: `a2ui_render({ intent, surfaceId, description })`
   - `intent`: `"create"` (default) for a new surface, `"update"` to revise one already rendered.
   - `surfaceId`: reuse the SAME id across every iteration of one design so updates replace it in place, not append a second surface. Omit only on the very first `create` (a generated id comes back in the result).
   - `description`: natural language. Be concrete about **structure and content** (what sections, what fields, what actions) — do NOT describe colors/spacing/theme, the catalog already owns that.
   - `a2ui_render` has no memory of prior renders. On an `intent="update"` call, describe what already exists AND what should change, in the same message — e.g. "The form currently has Name and Email fields; add a Phone field between them and make Email required."
   - Returns a **JSON string**. Parse it to get `{ surfaceId, operations }`.
3. **Push**: `ui_preview_render({ surfaceId, operations })` — pass the two fields from step 2 through UNCHANGED. Never hand-edit `operations`; if the render looks wrong, fix it by calling `a2ui_render` again with a clearer description, not by patching the envelope yourself.
4. **Ask for feedback**, then repeat from step 2 for the next change.

Optional: `ui_preview_show_requirement({ specPath, requirementId })` scrolls the paired spec viewer to the requirement a mockup section corresponds to, so the user can see spec and mockup side by side.

---

## 3. The catalog — 18 components, nothing else

`a2ui_render` is constrained to exactly these. Describe UI in terms of what's actually buildable from this list; don't ask for components outside it (tables, charts, date-range pickers, rich text editors, etc. don't exist — approximate with what's here, e.g. a `List` of `Row`s for a table-like layout).

| Component | Use for |
|---|---|
| `Text` | Labels, headings (`variant`: h1–h5, caption), body copy |
| `Image` | Photos/illustrations (`variant`: icon, avatar, smallFeature, largeFeature, header) |
| `Icon` | A single named icon glyph |
| `Video` | An embedded video player |
| `AudioPlayer` | An embedded audio player with optional caption |
| `Row` | Horizontal layout container |
| `Column` | Vertical layout container |
| `List` | A scrollable collection, horizontal or vertical |
| `Card` | A visually grouped, bordered content block |
| `Tabs` | Switchable named panels |
| `Divider` | A thin separator line (horizontal or vertical) |
| `Modal` | A trigger element that opens an overlay dialog on click |
| `Button` | An action (`variant`: primary, default, borderless) |
| `TextField` | Single-line, long-text, number, or obscured (password) text entry |
| `CheckBox` | A single boolean toggle with label |
| `ChoicePicker` | Single- or multi-select from a list of options (checkbox/radio list or chip row), optionally filterable |
| `Slider` | A numeric value on a min/max range |
| `DateTimeInput` | A date, time, or datetime value |

Containers (`Row`/`Column`/`List`) hold other components by reference; `Card`/`Modal`/`Tabs` hold either a single child or, for `Tabs`, one child per tab. You never need to know the exact JSON field names for this — `a2ui_render` handles it — but knowing the shape helps you describe nesting clearly ("a Card containing a Column of three TextFields" reads unambiguously to the sub-agent).

---

## 4. BOS's visual identity (already applied — don't ask for it)

The catalog renders every component in BrowserOS's real dark theme automatically:

- Dark, translucent surfaces (cards, panels) — not solid white/black blocks.
- **Violet** is the one accent color: primary buttons, checked/selected states (checkboxes, sliders, selected chips/tabs).
- Native `DateTimeInput` pickers render in dark mode.
- Dense spacing, small text — consistent with the rest of BOS.

Don't spend words in `description` asking for "a dark theme" or "make the button blue" — it's already handled. Spend that budget on structure, copy, and behavior instead.

---

## 5. Iteration tips

- Keep `surfaceId` stable across the whole design session for one screen; only start a new one if the user is explicitly designing a SECOND, distinct screen.
- Prefer one focused `description` per iteration ("add a Cancel button next to Save") over re-describing the whole screen from scratch each time — `a2ui_render` is told what already exists via your own description, so be precise about the delta.
- After each render, ask a focused question ("Does this layout match what you had in mind?") rather than an open-ended "What do you think?"
- If a render comes back visibly wrong or `ui_preview_render`'s result string reports an error, don't hand-edit anything — call `a2ui_render` again with a clearer, more specific description.

---

## 6. What the envelope actually looks like (for troubleshooting only — never write this by hand)

`a2ui_render`'s result, once parsed, is `{ "surfaceId": "...", "operations": [...] }`. Each operation is one A2UI v0.9 message; a fresh surface's operations typically look like:

```json
{
  "surfaceId": "profile-form",
  "operations": [
    { "version": "v0.9", "createSurface": { "surfaceId": "profile-form", "catalogId": "https://a2ui.org/specification/v0_9/basic_catalog.json" } },
    {
      "version": "v0.9",
      "updateComponents": {
        "surfaceId": "profile-form",
        "components": [
          { "id": "root", "component": "Column", "children": ["heading", "card"] },
          { "id": "heading", "component": "Text", "text": "Edit profile", "variant": "h2" },
          { "id": "card", "component": "Card", "child": "field" },
          { "id": "field", "component": "TextField", "label": "Name", "value": "" }
        ]
      }
    }
  ]
}
```

Notes if you ever need to read/debug one of these: the root component's `id` is always `"root"`; a component's type is the `component` field (not `type`); containers reference children by `id` string (an array for `Row`/`Column`/`List`, a single string for `Card`'s `child` or a `Tabs` entry's `child`). You should never construct this yourself — this section exists only so a malformed or unexpected result is recognizable as a real bug worth reporting, not silently passed through.
