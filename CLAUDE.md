# CLAUDE.md — BrowserOS

BrowserOS (BOS) is a single‑page, server‑side‑rendered "operating system in the browser" (Next.js App Router + React + Zustand + CopilotKit) with an agentic assistant that can operate and **modify BOS itself**.

**Before changing anything, read `docs/dev/architecture-overview.md`** — the full developer docs live under `docs/dev/` (architecture, data layout, API routes, extension recipes, gotchas). Specifications live in **external spec stores** (018-external-spec-store), not the source tree: independent git repos under `BOS_SPECS_ROOT` (default `/specs`, gitignored; seeded on first run from `seed/spec-store/`) — a BOS-owned system store `bos-system-specs` and a user store `user-specs`. Core requirements are `bos-system-specs/000-browseros-core/spec.md` (drift: `bos-system-specs/discrepancies.md`); project principles live in the spec-kit **constitution** at `bos-system-specs/.specify/memory/constitution.md`; feature specs use `<store>/<NNN-feature>/` and are authored via the **Build Studio** app/agent. The spec-kit **engine** (templates + command prompts) stays in source at `.specify/templates`. End‑user docs are under `docs/usage/`.

## Working rules
- Work on a **feature branch** (`git checkout -b bos/<short-name>`); make focused edits; **don't** touch secrets, `package.json`, lockfiles, or build config unless asked.
- After editing: `npx tsc --noEmit` and `npm run lint`; fix what you broke. `src/` hot‑reloads under `npm run dev`. **Do not run `npm run build` while `next dev` is running** (shared `.next`).
- Update `docs/` (and the relevant spec in the system store, `bos-system-specs/…`, via Build Studio if architecture changed) when you add/modify/remove a feature.

## Orientation
- Server‑only code (`import "server-only"`, Node/`fs`/secrets) lives behind `src/app/api/**/route.ts`; clients talk over `fetch`. `src/os/types.ts` is framework‑free.
- **The VFS (`data/vfs`, via `src/os/vfs.ts`) is the user's sandbox — NOT BOS source.** Edit `src/` to change BOS.
- OS state: `src/store/os-store.ts` (+ `os-provider.tsx`), seeded SSR in `src/app/page.tsx`.
- Apps: built‑in = a self‑describing folder `src/apps/<id>/` (`manifest.ts` + `index.tsx`), auto‑discovered by `tools/gen-apps.mjs` — no central registry (`src/os/apps.ts` + `src/components/apps/registry.tsx` are thin shims over the generated lists); installed = iframe served from GitFS by `src/app/apps/[...slug]/route.ts`.
- Assistant: **server-owned runs (v2)** — the agent loop lives on the server (`src/lib/assistant/`: `run-manager.ts`, `agent-loop.ts`, `model-turn.ts`, `start-run.ts`), browsers attach to an NDJSON event stream and execute frontend tools. Tools live in one registry (`src/lib/assistant/registry.ts` + `tools/server/*` server tools; `tools/frontend-declarations.ts` + `components/agent/v2/FrontendToolsV2.tsx` client tools). Interception via `hooks.ts`. UI = `src/components/agent/v2/`. Instructions = active agent + memory + skills (`instructions.ts`). Design/plan: `docs/plans/2026-07-11-assistant-v2-server-runs.md`. (CopilotKit is retired from the chat path; it remains only as a markdown renderer.)
- Settings tabs are pluggable config namespaces (`src/lib/config/registry.ts`) — adding one also exposes it to the assistant.
- All runtime state persists as files under `./data` (gitignored).

## Common locations
- Settings → Skills page: `src/components/apps/settings/SkillsTab.tsx` + `src/lib/agent/skills/store.ts` + `src/app/api/skills/route.ts`.
- Settings tabs: `src/components/apps/settings/` + `src/apps/settings/index.tsx` (entry).
- Sub‑agents / delegation: `src/lib/agent/subagents/`.
- Build Studio (spec-kit authoring): app `src/apps/build-studio/`, server logic `src/lib/specs/` (`stores.ts` discovery + manifest, `store-git.ts` build-free candidate/promote, `seed.ts`) + `src/lib/dev/spec-fs.ts` (multi-root, store-prefixed paths) + `src/app/api/specs/route.ts`; the agent & "Build Studio" skill are seeded in `subagents/store.ts` / `skills/store.ts`. Specs live in external stores under `BOS_SPECS_ROOT` (`bos-system-specs`, `user-specs`), each a self-describing folder (git repo + `spec-store.json`); the constitution is in the system store at `.specify/memory/constitution.md`. Store config: `src/os/specs-dir.ts`.

## Multi-user Docker deployment (`bastion/`)
- `bastion/` is a standalone Node.js/Express sub-project with its own `package.json` and `tsconfig.json`. Do not `npm install` in it unless you intend to modify bastion dependencies.
- `Dockerfile` (repo root) + `docker-entrypoint.sh` — builds BOS as a Docker image exposing port **8090** (the Supervisor). `docker-entrypoint.sh` runs `npm install` if `node_modules` is absent (supports per-user named volumes).
- `BOS_DATA_DIR` env var (`src/os/data-dir.ts`) — already supported; the bastion sets this to `/app/data` in each user's container.
- `docker-compose.yml` — bastion + `bos-net` bridge; user BOS containers are spawned at runtime via dockerode, never defined in Compose.
- `docker-compose.keycloak.yml` — adds a Keycloak OIDC service with a pre-seeded `bos` realm.
- See `docs/dev/deployment.md` for the deployment guide.
