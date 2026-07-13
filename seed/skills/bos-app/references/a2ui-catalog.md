# A2UI Catalog for BOS App Design

How to render and iterate on live UI mockups in the UI Preview app during the design phase of a `bos-app` session. BOS ships its OWN dark-themed A2UI v0.9 catalog (`src/apps/ui-preview/catalog.tsx`) — mockups render in BrowserOS's real visual language (violet accents, translucent dark surfaces), not the protocol's generic reference styling.

---

## 0. What this actually is (read first)

A2UI is a **fixed component protocol, NOT an HTML/CSS/JavaScript page.** There is no `<script>`, no custom JavaScript, no CSS you write, no HTML tags — only the components in §3. Anything you describe that isn't one of them (a "showStep() function", "vanilla JavaScript", "localStorage", "CSS display:none/block") is **silently dropped**, and the mockup silently comes out non-functional. This is the #1 failure mode — do NOT fall into it. Interactivity is real, but only through the mechanisms in §4 (data bindings + `setData` actions + the Tabs component). It is a **design-time mockup surface only** — never shipped; the Developer implements the real UI as React components later.

---

## 1. When to use this

Use A2UI during the **iterative UI design phase** of a `bos-app` (Phase 3 of `SKILL.md`):

- The user describes a screen or a change to one.
- You call `ui_preview_generate` (create) or `ui_preview_patch` (change) — each generates AND renders in one step.
- The user sees the mockup update in the UI Preview window.

---

## 2. The tool flow

1. **Open (once per session)**: `ui_preview_open()` — opens or focuses the UI Preview window. Cheap to call again; it's a no-op if already open.
2. **Create / replace**: `ui_preview_generate({ description })` — generates the mockup from your natural-language description AND renders it in one call. Use it for a brand-new screen or to start the current one over. Be concrete about **structure, content, and behavior** (what sections, fields, actions) — do NOT describe colors/spacing/theme, the catalog owns that.
3. **Iterate**: `ui_preview_patch({ description })` — an incremental add/replace/remove on the mockup already showing. It reads the current mockup itself, so describe ONLY the change ("add a Phone field between Name and Email", "replace the dropdown with radio buttons") — do not restate the whole screen.
4. **Ask for feedback**, then repeat step 3 for each change.

There is no separate "render" step and no envelope to pass around — generation and rendering are one call now. Optional: `ui_preview_show_requirement({ specPath, requirementId })` scrolls the paired spec viewer to the requirement a mockup section corresponds to (only works while Build Studio is also open).

---

## 3. The catalog — 18 components, nothing else

Generation is constrained to exactly these. Describe UI in terms of what's actually buildable from this list; don't ask for components outside it (tables, charts, date-range pickers, rich text editors, etc. don't exist — approximate with what's here, e.g. a `List` of `Row`s for a table-like layout).

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

Containers (`Row`/`Column`/`List`) hold other components by reference; `Card`/`Modal`/`Tabs` hold either a single child or, for `Tabs`, one child per tab. You never need to know the exact JSON field names for this — `ui_preview_generate`/`ui_preview_patch` handle it — but knowing the shape helps you describe nesting clearly ("a Card containing a Column of three TextFields" reads unambiguously to the sub-agent).

---

## 4. Interactivity — making clicks and inputs actually work

The surface has a reactive **data model**: components read values from a path (`{"path":"/x"}`) and write to it, so interactions have real effect with no round-trip. Patterns:

- **Inputs hold state** — bind a TextField/CheckBox/Slider/ChoicePicker/DateTimeInput `value` to a path (`"value": {"path":"/form/email"}`), not a literal. The field then remembers input and other components can show it.
- **Single-choice / multi-select** — a `ChoicePicker` with `"variant":"mutuallyExclusive"` bound to a path (e.g. `/plan`) already highlights the picked option on click. Prefer it over hand-built clickable rows for "pick one of N".
- **A button that changes state** — `"action": {"event":{"name":"setData","context":{"target":"/step","value":2}}}`. Clicking sets `/step` = 2. The data-path key MUST be `target` (never `path`, which is reserved for read bindings). Only `setData` and `openUrl` action names do anything — don't invent others.
- **Show a live value** — bind a Text's `text` to the path (`"text":{"path":"/form/email"}`); for "Label: value" use a Row of a static label Text + a bound Text.
- **Tabs / multi-step wizards** — use the **Tabs** component (one entry per tab, each with a `child`). Clicking a header switches it automatically. To make **Next/Back buttons** move between tabs, bind the Tabs' `activeTab` to a path and set `activeTabPath` to that same path, then give each button a `setData` action on it:

  ```json
  { "id":"wizard","component":"Tabs","activeTab":{"path":"/step"},"activeTabPath":"/step",
    "tabs":[{"title":"Register","child":"t0"},{"title":"Plan","child":"t1"},{"title":"Finish","child":"t2"}] }
  ```
  A "Next" button inside tab 0 uses `{"event":{"name":"setData","context":{"target":"/step","value":1}}}`; "Back" uses `value:0`. Each button hardcodes the index of the tab it goes to.

---

## 5. BOS's visual identity (already applied — don't ask for it)

The catalog renders every component in BrowserOS's real dark theme automatically:

- Dark, translucent surfaces (cards, panels) — not solid white/black blocks.
- **Violet** is the one accent color: primary buttons, checked/selected states (checkboxes, sliders, selected chips/tabs).
- Native `DateTimeInput` pickers render in dark mode.
- Dense spacing, small text — consistent with the rest of BOS.

Don't spend words in `description` asking for "a dark theme" or "make the button blue" — it's already handled. Spend that budget on structure, copy, and behavior instead.

---

## 6. Iteration tips

- Prefer `ui_preview_patch` with one focused change per call ("add a Cancel button next to Save") over regenerating the whole screen each time — `ui_preview_patch` reads the current mockup itself, so describe just the delta.
- Use `ui_preview_generate` only to create a screen or deliberately start it over.
- After each render, ask a focused question ("Does this layout match what you had in mind?") rather than an open-ended "What do you think?"
- If a render comes back visibly wrong, call `ui_preview_patch` (or `ui_preview_generate`) again with a clearer, more specific description — never try to hand-edit anything.

---

## 7. What the underlying envelope looks like (for troubleshooting only — never write this by hand)

Under the hood each render is a set of A2UI v0.9 operations (`ui_preview_generate`/`ui_preview_patch` build them for you). A fresh surface's operations typically look like:

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
