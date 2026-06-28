# CLAUDE.md — BrowserOS

BrowserOS (BOS) is a single‑page, server‑side‑rendered "operating system in the browser" (Next.js App Router + React + Zustand + CopilotKit) with an agentic assistant that can operate and **modify BOS itself**.

**Before changing anything, read `docs/dev/architecture-overview.md`** — the full developer docs live under `docs/dev/` (architecture, data layout, API routes, extension recipes, gotchas). Requirements are in `specs/000-browseros-core/spec.md` (where code diverges from spec, see `specs/discrepancies.md`). Project principles live in the spec-kit **constitution** at `.specify/memory/constitution.md`; new feature specs use `specs/<NNN-feature>/` (spec-kit) and are authored via the **Build Studio** app/agent; `specs/overview.md` maps all features. End‑user docs are under `docs/usage/`.

## Working rules
- Work on a **feature branch** (`git checkout -b bos/<short-name>`); make focused edits; **don't** touch secrets, `package.json`, lockfiles, or build config unless asked.
- After editing: `npx tsc --noEmit` and `npm run lint`; fix what you broke. `src/` hot‑reloads under `npm run dev`. **Do not run `npm run build` while `next dev` is running** (shared `.next`).
- Update `data/docs` (and `specs/000-browseros-core/spec.md` if architecture changed) when you add/modify/remove a feature.

## Orientation
- Server‑only code (`import "server-only"`, Node/`fs`/secrets) lives behind `src/app/api/**/route.ts`; clients talk over `fetch`. `src/os/types.ts` is framework‑free.
- **The VFS (`data/vfs`, via `src/os/vfs.ts`) is the user's sandbox — NOT BOS source.** Edit `src/` to change BOS.
- OS state: `src/store/os-store.ts` (+ `os-provider.tsx`), seeded SSR in `src/app/page.tsx`.
- Apps: built‑in = a self‑describing folder `src/apps/<id>/` (`manifest.ts` + `index.tsx`), auto‑discovered by `tools/gen-apps.mjs` — no central registry (`src/os/apps.ts` + `src/components/apps/registry.tsx` are thin shims over the generated lists); installed = iframe served from GitFS by `src/app/apps/[...slug]/route.ts`.
- Assistant: CopilotKit wiring in `src/components/agent/` (`*Actions.tsx` register tools; mirror new tools in `src/lib/agent/tool-manifest.ts`). Instructions = `src/lib/agent/config.ts` (CORE_POLICY) + active agent + memory + skills.
- Settings tabs are pluggable config namespaces (`src/lib/config/registry.ts`) — adding one also exposes it to the assistant.
- All runtime state persists as files under `./data` (gitignored).

## Common locations
- Settings → Skills page: `src/components/apps/settings/SkillsTab.tsx` + `src/lib/agent/skills/store.ts` + `src/app/api/skills/route.ts`.
- Settings tabs: `src/components/apps/settings/` + `src/apps/settings/index.tsx` (entry).
- Sub‑agents / delegation: `src/lib/agent/subagents/`.
- Build Studio (spec-kit authoring): app `src/apps/build-studio/`, server logic `src/lib/specs/` + `src/lib/dev/spec-fs.ts` + `src/app/api/specs/route.ts`; the agent & "Build Studio" skill are seeded in `subagents/store.ts` / `skills/store.ts`. Specs live under `specs/`; constitution at `.specify/memory/constitution.md`.
