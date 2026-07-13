# BOS Features & Components Guide

How to design and build solid BOS features and reusable components. This guide focuses on architecture, separation of concerns, tool registration, and patterns that keep BOS maintainable as the system grows.

Related reading: [Apps guide](./apps.md) · [Style guide](./style-guide.md) · [Design heuristics](../design-heuristics.md) · [Architecture overview](../architecture-overview.md) · [Extending BOS](../extending-bos.md).

---

## 1. What is a BOS feature?

A feature is a vertical slice of functionality that typically spans multiple layers:

- **Core feature** — touches the OS shell, state, or platform (e.g. central logging, version control).
- **Subsystem feature** — adds capability to an existing subsystem (e.g. a new memory type, a new scheduler trigger).
- **Component/service** — a reusable server-side or client-side building block (e.g. `HttpLogSink`, `A2UIRenderer`).
- **Integration** — connects BOS to an external service (e.g. GSuite, Telegram).

When in doubt, start by identifying the layer that owns the state and the layer that owns the UI.

---

## 2. Architectural principles

### Layer separation

BOS is organized in layers:

- **Presentation** — React components in `src/components/` and `src/apps/`.
- **Business logic** — hooks and services in `src/lib/...`.
- **Data access** — repositories and external-service clients in `src/lib/.../postgres/`, `src/lib/.../sinks/`, etc.

Keep these layers distinct. A component renders; a hook coordinates; a service holds domain rules; a repository writes data.

### Services and repositories

Use interfaces and concrete implementations:

- **Service** — domain logic that may call other services or repositories. Name ends with `Service`.
- **Repository** — data access. Name matches the domain (e.g. `JobsRepository`) with concrete implementations like `PGJobsRepository`.

Example:

```ts
// src/lib/logging/interface/log-sink.ts
export interface LogSink { ... }

// src/lib/logging/sinks/http-log-sink.ts
export class HttpLogSink implements LogSink { ... }

// src/lib/logging/services/logging-service.ts
export class LoggingService { ... }
```

### Dependency injection

Inject dependencies rather than importing singletons directly. This makes testing easier and avoids tight coupling. Pass repositories, API clients, and config into services and hooks.

### Single responsibility

- One hook = one query or one mutation.
- One component = one logical unit.
- One service = one domain responsibility.

If a file grows beyond ~250 lines or starts handling unrelated concerns, split it.

### Open/closed

Add new variants by introducing new files, not by special-casing existing ones. For example, add a new log sink as a new `LogSink` implementation rather than adding `if` branches inside an existing sink.

---

## 3. Adding a capability or tool

Most features expose something to the assistant or to other code. The canonical path is through `src/lib/agent/capabilities-registry.ts`.

### Decide the context

- `"action"` — client-only CopilotKit action (no server tool counterpart).
- `"tool"` — server tool only.
- `"both"` — both server tool and client action.
- `"deferred"` — server tool that must run outside the normal chat loop (e.g. `delegate_to_developer`).

### Register the capability

Add an entry with a clear group, description, and schema. Group names become categories in **Settings → Agents → [agent] → Tools**.

### Implement the handler

- Server tools live in `src/lib/assistant/tools/server/` (the single registry shared by the primary run and every delegation kind — `src/lib/agent/subagents/tools.ts` was retired, see [Sub-agents & delegation](../assistant/sub-agents-and-delegation.md)).
- Client actions live in `src/components/agent/` and are wrapped in CopilotKit action components.

### Progressive disclosure

Don't expose every internal helper as a tool. Expose the minimal surface the agent needs, and make advanced tools deferred or hidden behind configuration.

### Tier 2 registration mechanics (runtime surface tools)

`src/lib/assistant/client/surface-tools.ts` is the registry a mounted app window uses to contribute tools that only exist while its window is open (013-build-studio-agentic V2):

- `registerAppSurfaceTools(windowId, tools)` — call in a `useEffect` on mount, passing `SurfaceTool[]` (`{ declaration, handler }` pairs); returns an unregister function to return from the effect's cleanup.
- `getActiveSurfaceToolDeclarations()` — the union of every currently-registered window's declarations; `run-client.ts`'s `sendMessage` calls this automatically on every send, so a chat embed never has to thread tool declarations through as props.
- `findSurfaceToolHandler(name)` — looks up a registered handler by name; the run-client dispatcher tries this after the always-on global frontend-tool handlers, and one surface tool's handler can call another's this way (e.g. UI Preview's `ui_preview_show_requirement` delegates to Build Studio's `buildstudio_artifact_open`).

Also register the tool ids in `capabilities-registry.ts` (group by app name, `deferred: true`) so they're permissioned per agent and show up in the Settings capability picker, even though the handler only exists while the window is mounted — see `buildstudio_artifact_open`/`ui_preview_render` for the pattern.

---

## 4. Adding configuration

When a feature needs user-tunable settings:

1. Add a `ConfigRegistration` to `REGISTRATIONS` in `src/lib/config/registry.ts`.
2. Define `namespace`, `title`, `order`, `fields`, and optional `customComponent`.
3. Provide `load`/`save` (simple cases can use `patchNamespace`).
4. If using a custom component, place it in `src/components/apps/settings/` and map it in `CUSTOM_TABS` in `src/apps/settings/index.tsx`.

Keep config schemas backward-compatible. A future rollback may run older code against newer data.

---

## 5. Adding a server service

1. Define the public interface in `src/lib/<area>/interface/`.
2. Implement the service in `src/lib/<area>/services/`.
3. Add concrete data access in `src/lib/<area>/postgres/` or `src/lib/<area>/sinks/`.
4. Wire the service in a barrel file or DI helper (e.g. `src/lib/logging/server-logger.ts`).
5. Call the service from server tools or API routes; don't call it directly from components.

---

## 6. Adding a frontend component

1. Determine if it is chrome (docked, titlebar, modal) or app content.
2. Use the [Style guide](./style-guide.md) recipes for buttons, inputs, modals, sidebars, etc.
3. Mark interactive components `"use client"`.
4. Read OS state with selectors: `useOSStore((s) => s.someAction)`.
5. Keep components free of direct data fetching; use hooks.

### Reusable components

BOS intentionally avoids a shared design-system package. If a pattern repeats 3+ times *within one file*, extract a small local component. If it repeats across apps, consider whether it belongs in `src/components/` as a shared OS chrome component.

---

## 7. Testing

- Type-check: `npx tsc --noEmit`.
- Lint: `npm run lint`.
- For server logic, write small ad-hoc test modules with `runAll()` if no test runner is wired.
- For UI, verify hydration (no client-only initial state) and scroll behavior.
- For tools, test the full loop from agent invocation to result.

---

## 8. Common pitfalls

- **Leaking layers** — components importing repositories directly, services importing React.
- **God files** — one service doing persistence + business logic + HTTP concerns.
- **Tight coupling to implementation** — importing `PG*` classes outside of DI wiring.
- **Hydration mismatches** — client-only initial state in a server-rendered component.
- **Over-exposing tools** — registering internal helpers as top-level capabilities.

---

## 9. Example: central logging

The central logging feature (`specs/bos-system-specs/017-central-logging/`) demonstrates these principles:

- **Interface**: `LogSink`.
- **Implementations**: `HttpLogSink`, `FileLogSink`.
- **Service**: `LoggingService` (buffered, fire-and-forget, re-buffers on sink failure).
- **Context**: `AsyncLocalStorage` for `withLogContext` / `getLogContext`.
- **Client**: `browser-logger.ts` captures console errors and posts batches.
- **Config**: `logging` namespace in `src/lib/config/registry.ts`.

This same shape — interface + service + context + client + config — fits most new BOS subsystems.
