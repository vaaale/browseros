---
name: ui-designer-craft
description: How to design a BOS UI live with the user — the A2UI component catalog and its interactivity model, BOS's UI conventions, and the generate/patch iteration loop in the UI Preview app. Craft, not process.
when_to_use: Whenever you are designing or iterating on a UI surface for a BOS feature, app or marketplace item — under any spec framework. Load this before calling ui_preview_generate or ui_preview_patch.
created_by: seed
pinned: true
---

This skill holds the **craft of designing a BOS UI**: what components exist, how they are made interactive, what BOS's UI conventions are, and how to iterate on a mockup in front of the user. It is method-neutral — none of it changes when the spec framework changes.

It does not decide *whether* a UI is needed, *what* the feature does, or *when* in a pipeline design happens. Requirements come from the `intent` skill; BOS's structural facts come from `bos-domain`; pipeline sequencing belongs to the active framework's driver skill.

═══════════════════════════════
UI DESIGN (live A2UI)
═══════════════════════════════

1. Open the UI Preview app with `ui_preview_open()` (no args; opens or focuses it). Keep it open for the rest of the session.
2. Read `references/ui-conventions.md` and `references/a2ui-catalog.md`.
3. Call `ui_preview_generate({ description })` to generate AND render the initial mockup in one step (there is no separate render call).
4. Show the user the mockup and ask for feedback.
5. Iterate with `ui_preview_patch({ description })` for incremental changes (add/replace/remove an element) — it reads the current mockup itself, so describe only the change. Use `ui_preview_generate` again only to start the screen over.
6. For each UI requirement, call `ui_preview_show_requirement(specPath, requirementId)` to scroll the artifact viewer to the related requirement.

GATE: The user approves the UI design.

CRITICAL: the UI Preview renders a **fixed A2UI component catalog, not an HTML/CSS/JavaScript page**. Never describe `<script>`, "vanilla JavaScript", a "showStep() function", "localStorage", or "CSS display:none" — none of that exists and it is silently dropped (this is the #1 cause of "the buttons don't work"). Build tabbed/multi-step UIs with the **Tabs** component; make interactions real via data-model bindings and `setData` actions. Describe structure, content, and behavior — not colors or spacing (the dark theme is automatic). See `references/a2ui-catalog.md` for the component list, the interactivity model, and worked examples.

═══════════════════════════════
A2UI OR HTML
═══════════════════════════════

A live A2UI surface is not the only way to mock up a BOS UI, and usually not the right one. A plain self-contained HTML file is the default for anything shipping as ordinary React — a window app, a Settings tab, a marketplace item — because it is a real, diffable, persistent artifact that survives the conversation. Reach for A2UI when the feature's own shipped UI genuinely renders through A2UI, or when the value is in iterating live with the user right now rather than in leaving a file behind.

═══════════════════════════════
WHERE THE HTML MOCKUP GOES
═══════════════════════════════

**The mockup is an artifact OF THE FEATURE, and it is saved beside that feature's spec — never in the user's file sandbox.** It is `mockup.html`, in the SAME directory as the unit's own documents (`spec.md`, or under another method `product-brief.md`/`prd.md`/`ux.md`):

- **`marketplace-item`** → **`item-<id>/mockup.html`**, written with `app_spec_write` (and iterated with `app_spec_edit`/`app_spec_patch`). The item's spec lives physically inside the item, and `file_*` cannot reach it at all.
- **`bos-core` / `builtin-app`** → **`<spec-dir>/mockup.html`** under `/Specs/<store>/<project-id>/<NNN-slug>/`, written with `file_write` and iterated with `file_edit`/`file_patch`, sibling to `spec.md`.

Never `/mockups/…`, `/workspace/…`, `/Documents/…` or anywhere else in the VFS. That is the user's own sandbox: a mockup there does not ride the feature branch, does not promote or discard with the feature, and is invisible to everyone who opens the spec afterwards — the design work survives the conversation only if it sits with the spec it belongs to.

**Including the staging directory the app's own code is being built in.** That is the trap, because putting it there feels right: the staging directory holds FACETS (`app/`, `services/`, `config/`, `docs/`), and `app_build` carries exactly those into the item. A `mockup.html` beside them is not a facet, is not installed, and is left in scratch space while the app it describes ships without it.

Three sessions in a row lost a finished mockup this way — `/mockups/<app>.html`, then `/workspace/<app>/mockup.html`. Each time the design work was real and the file simply was not part of the app.

If a write is refused because no feature branch is active, that applies to BOTH routes (`data/user-apps` is branch-coupled exactly as `/Specs` is). Call `dev_branch_request({ task: "<one line>" })`, wait for the user to confirm the name, then retry the same write — do not fall back to describing the mockup in prose, and do not save it somewhere unguarded to get past the error.

`web_view`'s live preview resolves `/Specs` (VFS) paths only, so it cannot preview an `item-<id>/mockup.html`. Write the file anyway and point the user at it, rather than moving the file somewhere previewable.

The `ui-designer` agent's own prompt carries the rest of the HTML workflow — the edit-and-refresh discipline, the style-guide rules, and the output contract — for methods that ship that agent. This skill covers the A2UI half of that choice in depth, because A2UI is the part with a fixed catalog you cannot discover by reading BOS's source; and it carries the rule above because it must hold under EVERY method, including those with no ui-designer agent at all.

═══════════════════════════════
HARD RULES
═══════════════════════════════

- Never write BOS source code, React/TSX, or app files. A mockup is a visual proxy, not an implementation.
- Never save an HTML mockup outside the feature's own spec directory — see "Where the HTML mockup goes". A mockup in the VFS sandbox is not part of the feature.
- Never leave the preview showing a stale draft while you talk about a newer one.
- Cover every screen and state the requirements imply — empty, populated, and any error/edge case called out. A mockup that only shows the happy path leaves exactly the ambiguity that designing up front exists to resolve.
- Never invent a literal connection URL, hostname or port for a value that depends on runtime or deployment. Use an obvious placeholder and flag it as an open question.
- If the requirements are ambiguous about what a screen should show, surface that as an open question rather than silently inventing a requirement nobody asked for.
