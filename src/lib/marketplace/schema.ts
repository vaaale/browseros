// Marketplace types + validation (028). A marketplace is a git repo whose root
// holds `marketplace.json`. Each item may expose an `app/` (pre-built, iframe)
// and/or a `spec/` (adoptable spec template). Registered marketplaces are listed
// in data/config/marketplaces.json. Framework-free (no server-only) so it is
// unit-testable and safe to import anywhere.

export interface MarketplaceItemApp {
  /** Path (relative to the marketplace repo root) to the app's served directory. */
  entrypoint: string;
  runtime: "iframe";
  version: string;
  /** lucide-react icon name. */
  icon?: string;
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

export interface MarketplaceItem {
  id: string;
  name: string;
  description: string;
  tags?: string[];
  app?: MarketplaceItemApp;
  spec?: MarketplaceItemSpec;
  skill?: MarketplaceItemSkill;
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

function relPathOk(p: unknown): p is string {
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
      if (a.runtime !== "iframe") throw new Error(`item ${o.id}: app.runtime must be "iframe"`);
      app = {
        entrypoint: a.entrypoint as string,
        runtime: "iframe",
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

    if (!app && !spec && !skill) throw new Error(`item ${o.id}: must expose an app, spec, and/or a skill`);
    return {
      id: o.id as string,
      name: o.name as string,
      description: typeof o.description === "string" ? o.description : "",
      tags: Array.isArray(o.tags) ? o.tags.filter((t): t is string => typeof t === "string") : undefined,
      app,
      spec,
      skill,
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
