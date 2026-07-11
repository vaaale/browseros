# A2UI Catalog for BOS App Design

How to generate and update UI surfaces in the UI Preview app using the A2UI protocol. For the full protocol and renderer details, see the installed `@copilotkit/a2ui-renderer` and `@ag-ui/a2ui-toolkit` packages.

---

## 1. When to use A2UI

Use A2UI during the **iterative UI design phase** of a `bos-app`:

- The user describes a UI change.
- You call the `a2ui_render` server tool to produce a validated operations envelope.
- You push the envelope to the UI Preview app with `ui_preview_render`.
- The user sees the mockup update in place.

Do not use A2UI for final built-in app code — that must be implemented by the Developer as React components. A2UI is a design-time surface only.

---

## 2. The A2UI flow

1. **Ensure the UI Preview app is open**: `bos_app_launch("ui-preview", { title: "UI Preview — <app>" })`.
2. **Describe the change**: intent, target surface id, and natural-language changes.
3. **Call `a2ui_render`**: returns a JSON operations envelope.
4. **Call `ui_preview_render`**: passes `{ surfaceId, operations }` to the UI Preview app.
5. **Iterate**: ask the user for feedback, then repeat from step 2.

---

## 3. Basic catalog components

Start with the basic catalog from `@copilotkit/a2ui-renderer`. Common components include:

- `Box` / `Flex` — layout containers
- `Text` — labels and body copy
- `Button` — actions
- `Input` / `TextArea` — text entry
- `Select` — single choice
- `Card` — grouped content
- `List` / `ListItem` — scrollable collections
- `Image` — icons or illustrations

Use these to compose screens. Do not invent custom components unless the user explicitly needs them and the renderer supports them.

---

## 4. Component IDs and binding

Every interactive A2UI component must have a stable `id`. IDs are used for:

- Targeting updates (`updateComponent`)
- Binding data (`dataModel`)
- Event routing back to the agent (future)

Rules:

- Use descriptive, kebab-case IDs: `task-list`, `create-button`, `provider-select`.
- IDs must be unique within a surface.
- When updating, reference the same ID — do not regenerate IDs between iterations.

---

## 5. Operations envelope

A typical operations envelope from `a2ui_render` contains one or more of:

- `createSurface` — initial surface creation (rare after the first render).
- `updateComponents` — add, remove, or replace components by ID.
- `updateDataModel` — update bound data without changing component structure.

Example payload shape:

```json
{
  "surfaceId": "ui-preview-1",
  "operations": [
    {
      "type": "updateComponents",
      "components": [
        {
          "id": "main-window",
          "type": "Flex",
          "direction": "column",
          "children": [
            { "id": "header", "type": "Text", "value": "My App" },
            { "id": "task-list", "type": "List", "items": [...] }
          ]
        }
      ]
    }
  ]
}
```

Always pass the exact envelope returned by `a2ui_render` to `ui_preview_render`. Do not hand-edit the envelope unless you are fixing an obvious renderer error.

---

## 6. BOS-specific design constraints

- **Dark theme only** — use the opacity palette (`bg-white/5`, `text-white/90`, etc.).
- **Dense UI** — default text size is `text-xs`; spacing is tight (`gap-1`–`gap-2`).
- **Icons** — use `lucide-react` names. App icons must exist in `src/components/desktop/icons.tsx`.
- **No external UI libraries** — shadcn, Radix, MUI, etc. are not allowed in BOS.
- **BOS-native components** — use A2UI's basic catalog. A BOS-specific catalog may be added later.

---

## 7. Iteration tips

- Keep the surface id stable across iterations so updates replace rather than append.
- For small changes, prefer `updateDataModel` or `updateComponents` over recreating the whole surface.
- After each render, ask a focused question: "Does this layout match what you had in mind?" rather than "What do you think?"
- If the renderer produces broken output, capture the error and call `a2ui_render` again with a clearer prompt or with recovery instructions.
