# Configuration system (pluggable Settings tabs = assistant tools)

A feature registers a **config namespace**; that single registration yields **both**
a Settings tab **and** assistant configuration tools. This is the preferred way to
make any value user‑editable.

---

## Pieces

- **`src/lib/config/types.ts`** — `ConfigSchema` (`namespace`, `title`,
  `description?`, `order?`, `fields: ConfigField[]`, `customComponent?`) and
  `ConfigField` (`key`, `label`, `type: text|password|number|boolean|select|
  textarea`, `options?`, `secret?`). `ConfigSchemaView` adds `values` (secrets
  blanked) + `secretsSet`.
- **`src/lib/config/registry.ts`** — `REGISTRATIONS: ConfigRegistration[]`, each
  `{ schema, load(), save(patch) }`. Helpers: `listConfigSchemas()`,
  `getRegistration(ns)`, `getConfigValue(ns, key)`.
- **`src/lib/config/store.ts`** — generic per‑namespace JSON at
  `data/config/<ns>.json` (`readNamespace` / `patchNamespace`). Some namespaces
  delegate to their own stores instead (provider → `provider.ts`, appearance →
  `settings.ts`).

---

## HTTP

`/api/config`:

- **GET** → `{ schemas: ConfigSchemaView[] }` — all schemas with current `values`
  (secret fields blanked) and `secretsSet`.
- **PATCH** `{ namespace, values }` → calls that registration's `save`.

The same schema is **auto‑exposed to the assistant** as the
`listConfigurableSettings` / `updateSetting` actions
([Actions & tools](../assistant/actions-and-tools.md)) — so adding a tab gives the
agent a config tool for free.

---

## Rendering (`src/apps/settings/index.tsx`)

The Settings app fetches `/api/config` and renders a tab per schema. If
`schema.customComponent` is set, a mapped React component renders instead of the
generic `<ConfigForm>`. Current `CUSTOM_TABS`:

```
appearance → AppearanceTab      ai-provider → ProviderSettings
assistant  → AssistantTab       skills      → SkillsTab
apps       → AppsTab            dev-harness → DevHarnessTab
datafs     → DataFsTab          self-modification → VersionsTab
```

Namespaces with `fields: []` + a `customComponent` are pure custom UIs (no generic
form).

---

## Registered namespaces (today)

| Namespace | Title | order | UI |
|---|---|---|---|
| `assistant` | Assistant | 5 | custom |
| `skills` | Skills | 6 | custom |
| `apps` | Apps | 8 | custom |
| `appearance` | Appearance | 10 | fields → `settings.ts` |
| `ai-provider` | AI Provider | 20 | custom → `provider.ts` |
| `dev-harness` | Dev Harness | 30 | custom → `config/store` |
| `datafs` | Data Isolation | 35 | custom |
| `self-modification` | Versions | 36 | custom |
| `browser-automation` | Browser Automation | 40 | generic fields → `config/store` |

---

## Adding a tab (recipe)

1. Add a `ConfigRegistration` to `REGISTRATIONS` in `registry.ts`
   (`schema.namespace`, `title`, `order`, `fields` and/or `customComponent`;
   `load`/`save`). For simple key/values, `save` can use `patchNamespace(ns, patch)`.
2. For a custom UI, add `src/components/apps/settings/MyTab.tsx` and map it in
   `CUSTOM_TABS` in `src/apps/settings/index.tsx` by the `customComponent` key.
3. The fields are auto‑exposed to the assistant via `updateSetting` — no extra work.
4. Mark sensitive fields `secret: true` so they're masked in `/api/config`.
