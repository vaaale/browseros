# Build Studio

Build Studio is where you turn ideas into **specifications** and then into features. It
is the home of BOS's Software-As-A-Prompt workflow: every feature is described by a spec
(using GitHub spec-kit) before it is built, and the building is delegated to the
Developer.

## The window

Three panes, side-by-side. **Drag the dividers** between them to resize the tree and the
chat; the widths are remembered next time you open the app.

- **Left panel** — a tree of everything under `specs/`: each feature folder and its
  artifacts (`spec.md`, `plan.md`, `tasks.md`, …). Use the refresh button to reload it.
- **Centre panel** — selecting a feature shows its **pipeline status**
  (constitution → specify → clarify → plan → tasks → analyze → implement → converge) and
  its task progress. Selecting an artifact shows it rendered, with an **Edit** button for
  quick changes.
- **Right panel** — the **Build Studio agent chat** (the assistant pinned to the Build
  Studio agent, with its own conversation list). When the agent creates or edits a spec it
  will **open it in the centre panel** for you and refresh the tree, so you always see what
  it is working on.

## Authoring specs

Just describe a feature in the **chat on the right** (or open the normal Assistant and ask
it for spec work — it delegates to the Build Studio agent). It will:

1. **specify** — create `specs/<NNN-feature>/spec.md` from the template.
2. **clarify** — ask questions and record the answers in the spec.
3. **plan** / **tasks** — produce `plan.md` and `tasks.md`.
4. **implement** — hand the work to the **Developer**, which writes the code on a feature
   branch.
5. **analyze** / **converge** — check that the spec and the code still agree.

You stay in control: review each artifact in the app, edit it directly, and approve
before moving on.

## Good to know

- Build Studio only ever edits files under `specs/` and `.specify/` — it never writes app
  code itself; implementation always goes to the Developer.
- Project-wide principles live in the **constitution** (`.specify/memory/constitution.md`).
- New feature folders are numbered automatically (`001-…`, `002-…`).
