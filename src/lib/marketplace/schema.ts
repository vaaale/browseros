// Marketplace types + validation (028). A marketplace is a git repo whose root
// holds `marketplace.json`. Each item may expose an `app/` (pre-built, iframe)
// and/or a `spec/` (adoptable spec template). Registered marketplaces are listed
// in data/config/marketplaces.json. Framework-free (no server-only) so it is
// unit-testable and safe to import anywhere.

export interface MarketplaceItemApp {
  /** Path (relative to the marketplace repo root) to the app directory (iframe)
   *  or plugin directory (plugin-served). */
  entrypoint: string;
  /**
   * "iframe" — files served from the filesystem via /apps/<id>/.
   * "plugin-served" — app served via the plugin's own route at /api/plugin/<id>/app;
   *   no files are copied to user-apps.
   */
  runtime: "iframe" | "plugin-served";
  version: string;
  /** lucide-react icon name. */
  icon?: string;
}

/** A BOS plugin (integration or voice engine) loaded at runtime via the
 *  bos-plugin loader (data/bos-plugins/<id>/bos-plugin.json + index.js). */
export interface MarketplaceItemBosPlugin {
  /** Path (relative to the marketplace repo root) to the directory containing
   *  bos-plugin.json. */
  entrypoint: string;
  version: string;
  /** For a voice engine: the id it registers (`VoiceEnginePlugin.id`), so a
   *  catalog can name the engine without loading the plugin. Curated — a scan
   *  cannot derive it, so validation must carry it through rather than drop it. */
  engineId?: string;
}

export interface MarketplaceItemSpec {
  /** Path (relative to the marketplace repo root) to the adoptable spec folder. */
  path: string;
  version: string;
}

export interface MarketplaceItemSkill {
  /** Path (relative to the marketplace repo root) to the skill folder (contains SKILL.md). */
  path: string;
  version: string;
}

export interface MarketplaceItemServerPlugin {
  /** Path (relative to the marketplace repo root) to the plugin directory (contains plugin.json). */
  entrypoint: string;
  version: string;
}

export interface MarketplaceItemService {
  /** Path (relative to the marketplace repo root) to the item root — a
   *  directory containing services/service.json, config/, and optionally
   *  spec/, doc/, app/, hooks/ (user-specs/002-service-daemons). */
  entrypoint: string;
  version: string;
}

export interface MarketplaceItem {
  id: string;
  name: string;
  description: string;
  tags?: string[];
  app?: MarketplaceItemApp;
  spec?: MarketplaceItemSpec;
  skill?: MarketplaceItemSkill;
  serverPlugin?: MarketplaceItemServerPlugin;
  services?: MarketplaceItemService;
  /** OAuth integration plugin (registers manifest + adapters via the bos-plugin loader). */
  integration?: MarketplaceItemBosPlugin;
  /** Voice engine plugin (registers a TTS engine via the bos-plugin loader). */
  voiceEngine?: MarketplaceItemBosPlugin;
  /** 045 FR-012: a spec-framework pack — `method/method.json` plus templates
   *  and, usually, the agents that framework's process assumes. */
  method?: MarketplaceItemMethod;
}

export interface MarketplaceItemMethod {
  /** Descriptor id, e.g. "openspec". Matches method.json's own `id`. */
  id: string;
  version: string;
  /** Descriptor schema version, so a catalog can be filtered before install
   *  rather than failing at registration. */
  schemaVersion?: number;
  /** Selectable modules, surfaced at install so the user picks before anything
   *  registers (048 FR-006). Summary only — the full ModuleSpec lives in the
   *  pack's method.json; this is what the CATALOG needs to render a choice. */
  modules?: Array<{ id: string; label?: string; default?: boolean; requiresConfig?: boolean }>;
}

export interface MarketplaceManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  items: MarketplaceItem[];
}

/** A marketplace registered by the user, persisted in marketplaces.json. */
export interface RegisteredMarketplace {
  id: string;
  url: string;
  name: string;
  addedAt: string;
  lastSynced: string | null;
}

const ID_RE = /^[a-zA-Z0-9._-]+$/;

/** True iff `p` is a non-empty repo-relative path that cannot escape the repo.
 *  Exported because it is the ONE path-containment policy for untrusted
 *  marketplace paths — the client's plugin converters reuse it rather than
 *  re-deriving it. */
export function relPathOk(p: unknown): p is string {
  if (typeof p !== "string" || !p.trim()) return false;
  const norm = p.replace(/\\/g, "/");
  // No absolute paths, no traversal, no leading slash — must stay inside the repo.
  return !norm.startsWith("/") && !norm.split("/").some((seg) => seg === "..");
}

/**
 * Validate + normalize an untrusted `marketplace.json` (parsed JSON). Returns the
 * manifest, or throws with a clear reason — a malformed/hostile manifest must be
 * rejected before any of its paths are used (028 §N3/security).
 */
export function validateManifest(raw: unknown): MarketplaceManifest {
  if (!raw || typeof raw !== "object") throw new Error("marketplace.json is not an object");
  const m = raw as Record<string, unknown>;
  if (typeof m.id !== "string" || !ID_RE.test(m.id)) throw new Error("marketplace.json: invalid `id`");
  if (typeof m.name !== "string" || !m.name.trim()) throw new Error("marketplace.json: missing `name`");
  if (typeof m.version !== "string") throw new Error("marketplace.json: missing `version`");
  if (!Array.isArray(m.items)) throw new Error("marketplace.json: `items` must be an array");

  const items: MarketplaceItem[] = m.items.map((it, i) => {
    if (!it || typeof it !== "object") throw new Error(`item ${i}: not an object`);
    const o = it as Record<string, unknown>;
    if (typeof o.id !== "string" || !ID_RE.test(o.id)) throw new Error(`item ${i}: invalid \`id\``);
    if (typeof o.name !== "string" || !o.name.trim()) throw new Error(`item ${o.id}: missing \`name\``);

    let app: MarketplaceItemApp | undefined;
    if (o.app != null) {
      const a = o.app as Record<string, unknown>;
      if (!relPathOk(a.entrypoint)) throw new Error(`item ${o.id}: invalid app.entrypoint`);
      if (a.runtime !== "iframe" && a.runtime !== "plugin-served")
        throw new Error(`item ${o.id}: app.runtime must be "iframe" or "plugin-served"`);
      app = {
        entrypoint: a.entrypoint as string,
        runtime: a.runtime as "iframe" | "plugin-served",
        version: typeof a.version === "string" ? a.version : "0.0.0",
        icon: typeof a.icon === "string" ? a.icon : undefined,
      };
    }

    let spec: MarketplaceItemSpec | undefined;
    if (o.spec != null) {
      const s = o.spec as Record<string, unknown>;
      if (!relPathOk(s.path)) throw new Error(`item ${o.id}: invalid spec.path`);
      spec = { path: s.path as string, version: typeof s.version === "string" ? s.version : "0.0.0" };
    }

    let skill: MarketplaceItemSkill | undefined;
    if (o.skill != null) {
      const sk = o.skill as Record<string, unknown>;
      if (!relPathOk(sk.path)) throw new Error(`item ${o.id}: invalid skill.path`);
      skill = { path: sk.path as string, version: typeof sk.version === "string" ? sk.version : "0.0.0" };
    }

    let serverPlugin: MarketplaceItemServerPlugin | undefined;
    if (o.serverPlugin != null) {
      const sp = o.serverPlugin as Record<string, unknown>;
      if (!relPathOk(sp.entrypoint)) throw new Error(`item ${o.id}: invalid serverPlugin.entrypoint`);
      serverPlugin = { entrypoint: sp.entrypoint as string, version: typeof sp.version === "string" ? sp.version : "0.0.0" };
    }

    let services: MarketplaceItemService | undefined;
    if (o.services != null) {
      const sv = o.services as Record<string, unknown>;
      if (!relPathOk(sv.entrypoint)) throw new Error(`item ${o.id}: invalid services.entrypoint`);
      services = { entrypoint: sv.entrypoint as string, version: typeof sv.version === "string" ? sv.version : "0.0.0" };
    }

    function parseBosPlugin(raw: unknown, field: string): MarketplaceItemBosPlugin | undefined {
      if (raw == null) return undefined;
      const p = raw as Record<string, unknown>;
      if (!relPathOk(p.entrypoint)) throw new Error(`item ${o.id}: invalid ${field}.entrypoint`);
      return {
        entrypoint: p.entrypoint as string,
        version: typeof p.version === "string" ? p.version : "0.0.0",
        ...(typeof p.engineId === "string" ? { engineId: p.engineId } : {}),
      };
    }

    const integration = parseBosPlugin(o.integration, "integration");
    const voiceEngine = parseBosPlugin(o.voiceEngine, "voiceEngine");

    let method: MarketplaceItemMethod | undefined;
    if (o.method && typeof o.method === "object") {
      const m = o.method as Record<string, unknown>;
      if (typeof m.id !== "string" || !m.id) throw new Error(`item ${o.id}: method.id is required`);
      // RECONSTRUCTED, not spread — so every field must be named here or it is
      // silently dropped. That matters more than usual: BOS REWRITES this
      // manifest (034, merge-not-regenerate), so a field the parser does not
      // know about is not merely invisible at runtime, it is DELETED FROM DISK
      // on the next repair. `modules` was lost exactly that way, taking the
      // install-time module prompt with it — silently, because an absent
      // `modules` just means "no choice to offer".
      method = {
        id: m.id,
        version: typeof m.version === "string" ? m.version : "0.0.0",
        ...(typeof m.schemaVersion === "number" ? { schemaVersion: m.schemaVersion } : {}),
        ...(Array.isArray(m.modules)
          ? {
              modules: (m.modules as Record<string, unknown>[])
                .filter((x) => x && typeof x.id === "string")
                .map((x) => ({
                  id: x.id as string,
                  ...(typeof x.label === "string" ? { label: x.label } : {}),
                  ...(typeof x.default === "boolean" ? { default: x.default } : {}),
                  ...(typeof x.requiresConfig === "boolean" ? { requiresConfig: x.requiresConfig } : {}),
                })),
            }
          : {}),
      };
    }

    if (!app && !spec && !skill && !serverPlugin && !services && !integration && !voiceEngine && !method)
      throw new Error(`item ${o.id}: must expose at least one facet`);
    return {
      id: o.id as string,
      name: o.name as string,
      description: typeof o.description === "string" ? o.description : "",
      tags: Array.isArray(o.tags) ? o.tags.filter((t): t is string => typeof t === "string") : undefined,
      app,
      spec,
      skill,
      serverPlugin,
      services,
      integration,
      voiceEngine,
      method,
    };
  });

  return {
    id: m.id,
    name: m.name,
    version: m.version,
    description: typeof m.description === "string" ? m.description : undefined,
    items,
  };
}

/**
 * Validate a marketplace git URL against an allowlist (028/security). Allows
 * `https://` and scp-like `git@host:path` (ssh). In development ONLY, also allows
 * a local filesystem path / `file://` so a throwaway repo can be registered for
 * testing. Everything else (notably `ext::`, which runs arbitrary commands) is
 * rejected.
 */
export function validateMarketplaceUrl(url: string, opts?: { allowLocal?: boolean }): string {
  const u = (url ?? "").trim();
  if (!u) throw new Error("marketplace URL is required");
  if (/^https:\/\/[^\s]+$/i.test(u)) return u;
  if (/^git@[^\s:]+:[^\s]+$/.test(u)) return u; // scp-like ssh
  if (opts?.allowLocal && (/^file:\/\//i.test(u) || u.startsWith("/"))) return u;
  throw new Error(
    `Refused marketplace URL "${u}": only https:// (or ssh git@host:path) is allowed.`,
  );
}
