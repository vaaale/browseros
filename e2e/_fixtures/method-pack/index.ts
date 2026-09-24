// 045 T002a / FR-017a — the method-pack fixture harness.
//
// A hard prerequisite for 045 FR-017, 046 FR-015, 047 FR-013 and 048 FR-013.
// Every one of those needs a pack that can be installed and removed inside a
// single test run, with NO network and NO dependence on whatever happens to be
// installed in the environment (BOS's testing rule: a test bundles its own
// fixtures, and a test that passes by skipping is not coverage).
//
// PARAMETERIZED, not one fixed pack, because the consumers need genuinely
// different shapes:
//   - preflight (T018)   needs a v2 descriptor that CHANGES `leafMarker`, so
//                        discovery differs between versions.
//   - origin gate (T024) needs the SAME pack offered from two origins, one of
//                        them carrying a `plugin/` facet.
//   - registration       needs an unsupported `schemaVersion` to be refused.
//   - 048                needs a BMAD-shaped layout: modules, each with its own
//                        agents and its own visibility.
//
// Writes a real marketplace item (035 layout) and installs it the way BOS does
// — ONE symlink, copying nothing.
import { mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync, existsSync } from "fs";
import { join } from "path";

export interface MethodPackModule {
  id: string;
  label?: string;
  /** Selected by default at install. */
  default?: boolean;
  requiresConfig?: boolean;
  /** Agent ids this module contributes. */
  agents?: string[];
  visibility?: "picker" | "delegate-only";
}

export interface MethodPackOptions {
  packId?: string;
  label?: string;
  version?: string;
  /** The descriptor's leaf marker. Change it between versions to make an
   *  upgrade orphan content, which is what preflight must catch. */
  leafMarker?: string;
  /** Set to an unsupported value to exercise the registration refusal. */
  schemaVersion?: number;
  /** Ship a `plugin/` facet — server-side code, which triggers the origin gate
   *  and the install-time warning. */
  withPlugin?: boolean;
  /** Agent ids contributed by the pack root itself (non-modular packs). */
  agents?: string[];
  /** Skill ids bundled under `method/skills/` (COPIED at seed time, unlike
   *  agents — see docs/dev/method-packs.md on the asymmetry). */
  skills?: string[];
  /** BMAD-shaped modular layout. When present, `agents` is ignored. */
  modules?: MethodPackModule[];
  /** Where the pack's agents appear. */
  agentVisibility?: "picker" | "delegate-only";
  /** Where this method's specs live inside a repository (050 FR-003). `"."` is
   *  the repo root. Defaults to `specs`. */
  storeRoot?: string;
}

export interface WrittenPack {
  packId: string;
  /** Absolute path to the item directory. */
  itemPath: string;
  /** The descriptor, as written. */
  descriptor: Record<string, unknown>;
}

function agentMarkdown(id: string): string {
  return `---\nname: ${id}\ndescription: Fixture agent ${id}.\ntype: local\ntools: [file_read]\nskills: []\n---\n\nFixture body for ${id}.\n`;
}

/** Build the descriptor. Kept separate so a test can assert on it, or mutate it
 *  to produce a "v2" without re-deriving the whole layout. */
export function methodPackDescriptor(opts: MethodPackOptions = {}): Record<string, unknown> {
  const packId = opts.packId ?? "fixture-method";
  return {
    schemaVersion: opts.schemaVersion ?? 1,
    id: packId,
    label: opts.label ?? "Fixture Method",
    version: opts.version ?? "1.0.0",
    sections: [{ rel: "", kind: "active", leafMarker: opts.leafMarker ?? "spec.md", numbering: "nnn-slug" }],
    constitution: "memory/constitution.md",
    constitutionRoot: "own",
    discrepancies: { rel: "discrepancies.md", roots: ["own"] },
    artifacts: [{ id: opts.leafMarker ?? "spec.md", generates: "specify" }],
    artifactOrder: [opts.leafMarker ?? "spec.md"],
    phases: [
      {
        id: "specify",
        label: "Specify",
        requires: [],
        rules: [{ when: { kind: "exists", file: { rel: opts.leafMarker ?? "spec.md" } }, then: "done" }],
        else: "pending",
      },
    ],
    stateLabels: { done: "Done", pending: "Pending", blocked: "Blocked", na: "N/A" },
    templates: "templates",
    // Every registrable descriptor must say where its specs live inside a
    // repository (050 FR-003) — `registerMethod` refuses one that does not, so a
    // fixture omitting it would not install at all.
    storeRoot: opts.storeRoot ?? "specs",
    agentsDir: "agents",
    agentVisibility: opts.agentVisibility ?? "picker",
    agents: opts.agents ?? [],
    roles: {},
    // Full ModuleSpec objects, not bare ids. 048 T010 made `modules` a
    // `string[] | ModuleSpec[]` union; emitting only ids would make every
    // module read as `default: true` with no visibility, so a selection test
    // would silently assert against the wrong shape.
    ...(opts.modules
      ? {
          modules: opts.modules.map((m) => ({
            id: m.id,
            ...(m.default !== undefined ? { default: m.default } : {}),
            ...(m.requiresConfig !== undefined ? { requiresConfig: m.requiresConfig } : {}),
            ...(m.visibility ? { visibility: m.visibility } : {}),
            agentsDir: `modules/${m.id}/agents`,
          })),
        }
      : {}),
  };
}

/** Lay the pack out as a marketplace item under `<dataDir>/user-apps/items/`.
 *  Does NOT install it — call `installPack` for that, so a test can assert the
 *  uninstalled state first. */
export function writeMethodPack(dataDir: string, opts: MethodPackOptions = {}): WrittenPack {
  const packId = opts.packId ?? "fixture-method";
  const itemPath = join(dataDir, "user-apps", "items", packId);
  const descriptor = methodPackDescriptor(opts);

  mkdirSync(join(itemPath, "method", "templates", "commands"), { recursive: true });
  writeFileSync(join(itemPath, "method", "method.json"), JSON.stringify(descriptor, null, 2) + "\n");
  // A template the driver would read, so a path-resolution assertion has a
  // real target rather than an empty directory.
  writeFileSync(join(itemPath, "method", "templates", "spec-template.md"), "# Fixture spec template\n");
  writeFileSync(join(itemPath, "method", "templates", "commands", "specify.md"), "Fixture specify prompt.\n");

  // Agents: either flat, or BMAD-shaped per module.
  if (opts.modules?.length) {
    for (const m of opts.modules) {
      for (const a of m.agents ?? []) {
        mkdirSync(join(itemPath, "method", "modules", m.id, "agents", a), { recursive: true });
        writeFileSync(join(itemPath, "method", "modules", m.id, "agents", a, "AGENT.md"), agentMarkdown(a));
      }
    }
  } else {
    for (const a of opts.agents ?? []) {
      mkdirSync(join(itemPath, "method", "agents", a), { recursive: true });
      writeFileSync(join(itemPath, "method", "agents", a, "AGENT.md"), agentMarkdown(a));
    }
  }

  // Skills live under `skills/` — PLURAL. sourceRootFor pluralises the kind, so
  // a singular `skill/` makes seeding a silent no-op (046 T008).
  for (const s of opts.skills ?? []) {
    mkdirSync(join(itemPath, "method", "skills", s), { recursive: true });
    writeFileSync(join(itemPath, "method", "skills", s, "SKILL.md"), `---\nname: ${s}\n---\n\nFixture skill ${s}.\n`);
  }

  if (opts.withPlugin) {
    mkdirSync(join(itemPath, "plugin"), { recursive: true });
    writeFileSync(
      join(itemPath, "plugin", "bos-plugin.json"),
      JSON.stringify({ id: packId, name: opts.label ?? packId, version: opts.version ?? "1.0.0" }, null, 2) + "\n",
    );
  }

  // The manifest entry, so the item is installable through the normal catalog
  // path rather than a bespoke one.
  const manifestPath = join(dataDir, "user-apps", "marketplace.json");
  const manifest = existsSync(manifestPath)
    ? (JSON.parse(readFileSync(manifestPath, "utf8")) as { items?: unknown[] })
    : { id: "user-apps", name: "My Apps", version: "1.0.0", items: [] as unknown[] };
  manifest.items = [
    ...(manifest.items ?? []).filter((i) => (i as { id?: string }).id !== packId),
    {
      id: packId,
      name: opts.label ?? packId,
      description: "Fixture method pack.",
      method: { id: packId, version: opts.version ?? "1.0.0", schemaVersion: opts.schemaVersion ?? 1 },
      ...(opts.withPlugin ? { integration: { version: opts.version ?? "1.0.0" } } : {}),
    },
  ];
  mkdirSync(join(dataDir, "user-apps"), { recursive: true });
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

  return { packId, itemPath, descriptor };
}

/** Install it the 035 way: ONE symlink at `<dataDir>/system/<id>`, copying
 *  nothing. Idempotent. */
export function installPack(dataDir: string, packId: string): void {
  const link = join(dataDir, "system", packId);
  mkdirSync(join(dataDir, "system"), { recursive: true });
  rmSync(link, { force: true, recursive: false });
  symlinkSync(join(dataDir, "user-apps", "items", packId), link);
}

/** Remove the install link, leaving the item itself in place — exactly what
 *  uninstall does. */
export function uninstallPack(dataDir: string, packId: string): void {
  rmSync(join(dataDir, "system", packId), { force: true, recursive: false });
}

/** Rewrite an installed pack's descriptor in place — a pack UPGRADE. Use to
 *  exercise FR-010c, where nobody CHOSE the change that orphans content. */
export function upgradePack(dataDir: string, packId: string, opts: MethodPackOptions): void {
  writeFileSync(
    join(dataDir, "user-apps", "items", packId, "method", "method.json"),
    JSON.stringify(methodPackDescriptor({ ...opts, packId }), null, 2) + "\n",
  );
}

// ---------------------------------------------------------------------------
// The overlay (048 M2) — user-owned content that SHADOWS the installed pack.
//
// Separate from the pack writers above on purpose: the pack root is read-only
// to the user, the overlay is the only place they (or BMB) may write, and a
// fixture that blurred the two would let a test pass while writing somewhere
// the product forbids.
// ---------------------------------------------------------------------------

/** `data/method-packs/<packId>/` — the overlay root. NOT inside the item: the
 *  marketplace overwrites the item on upgrade, which is exactly what US3 says
 *  must not happen to customisations. */
export function overlayPath(dataDir: string, packId: string): string {
  return join(dataDir, "method-packs", packId);
}

export interface OverlayOptions {
  /** Agent ids to write at the overlay root. */
  agents?: string[];
  /** Agents per module, mirroring the pack's own `modules/<id>/agents/` shape. */
  modules?: Record<string, string[]>;
  /** Override an agent's body — for asserting that the OVERLAY copy is the one
   *  that resolved, rather than merely that some agent by that id exists. */
  body?: (id: string) => string;
}

/** Write overlay content. Safe to call repeatedly; each call adds. */
export function writeOverlay(dataDir: string, packId: string, opts: OverlayOptions = {}): string {
  const root = overlayPath(dataDir, packId);
  const body = opts.body ?? ((id: string) => agentMarkdown(id));

  for (const a of opts.agents ?? []) {
    mkdirSync(join(root, "agents", a), { recursive: true });
    writeFileSync(join(root, "agents", a, "AGENT.md"), body(a));
  }
  for (const [mod, agents] of Object.entries(opts.modules ?? {})) {
    for (const a of agents) {
      mkdirSync(join(root, "modules", mod, "agents", a), { recursive: true });
      writeFileSync(join(root, "modules", mod, "agents", a, "AGENT.md"), body(a));
    }
  }
  mkdirSync(root, { recursive: true });
  return root;
}

/** An overlay for a pack that is NOT installed — FR-004a's inertness case.
 *  Distinct helper because the whole point is that nothing else happens: no
 *  item, no manifest, no symlink. If a test had to remember not to call
 *  installPack, it would eventually forget. */
export function writeOrphanOverlay(dataDir: string, packId: string, opts: OverlayOptions = {}): string {
  return writeOverlay(dataDir, packId, opts);
}

/** Remove the overlay, leaving the pack installed — the "revert my
 *  customisations" path. */
export function clearOverlay(dataDir: string, packId: string): void {
  rmSync(overlayPath(dataDir, packId), { recursive: true, force: true });
}
