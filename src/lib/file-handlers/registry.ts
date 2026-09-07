import "server-only";
import { BUILTIN_APPS } from "@/os/apps";
import { listInstalledManifests } from "@/lib/apps/store";
import { baseMime } from "@/os/file-handlers";
import type { FileHandlerView } from "@/os/file-handlers";
import type { AppFileHandlerDeclaration, AppManifest } from "@/os/types";
import { readSelection } from "./selection";

// 036-file-type-handlers: "which apps can open a file of this type?"
//
// The registry is a pure DERIVATION from the currently-installed app set,
// recomputed on every query rather than cached at boot (design.md ADR-1). That
// is what makes FR-002 ("reflects only installed apps") true by construction:
// there is no stale copy to invalidate when an app is uninstalled, and no
// re-collection hook to forget on some future install path. Handler sets are a
// handful of manifests, so the cost is immaterial next to opening a menu.

// The row shape (`FileHandlerView`) lives in the shared client-safe module
// alongside the rest of the contract, so the Files app can name it without
// importing this server-only file.
export type { FileHandlerView };

/** Does a manifest's declared type cover this file's base type? Exact base-type
 *  match, or a trailing-slash family prefix ("image/" covers "image/png" but not
 *  "imagex/png"). Both sides are normalized, so a declaration written with a
 *  charset parameter still matches. */
export function matchDeclared(declType: string, mime: string): boolean {
  const declared = baseMime(declType);
  const base = baseMime(mime);
  if (!declared || !base) return false;
  return declared.endsWith("/") ? base.startsWith(declared) : declared === base;
}

/** Every currently-installed app, built-in and marketplace alike. */
async function allInstalledManifests(): Promise<AppManifest[]> {
  const installed = await listInstalledManifests().catch(() => [] as AppManifest[]);
  return [...BUILTIN_APPS, ...installed];
}

/** The first declaration in `manifest` that covers `mime`, if any. An app
 *  declaring both "text/" and "text/html" gets its most specific intent by
 *  listing that entry first — we do not merge duplicates. */
function declarationFor(manifest: AppManifest, mime: string): AppFileHandlerDeclaration | undefined {
  return manifest.fileHandlers?.find((d) => matchDeclared(d.type, mime));
}

function canRender(decl: AppFileHandlerDeclaration): boolean {
  return decl.capabilities.includes("render");
}

/** Handler rows for a type, in manifest-discovery order. Empty (never null) for
 *  a type nothing handles, so the Files app renders its menu exactly as before.
 *  Hidden apps are INCLUDED — html-viewer has no dock icon but is a perfectly
 *  good handler (FR-008 / A-6). */
export async function handlersFor(mime: string): Promise<FileHandlerView[]> {
  const manifests = await allInstalledManifests();
  const selected = await resolveSelected(mime, manifests);
  const rows: FileHandlerView[] = [];
  for (const manifest of manifests) {
    const decl = declarationFor(manifest, mime);
    if (!decl) continue;
    rows.push({
      appId: manifest.id,
      name: manifest.name,
      icon: manifest.icon,
      label: decl.label ?? manifest.name,
      capabilities: decl.capabilities,
      isDefault: decl.default === true,
      selected: selected?.appId === manifest.id,
      decl,
    });
  }
  return rows;
}

/** The handler double-click uses for this type, or null to fall back to the
 *  Files app's own in-app viewer/editor.
 *
 *  Order: the user's choice, then a manifest `default: true`, then nothing —
 *  and at every step the candidate must be BOTH currently installed AND
 *  render-capable for the type. That single guard is what enforces FR-011 (a
 *  selection pointing at an uninstalled app silently expires rather than
 *  launching a dead window) and A-5 (an edit-only handler is never the
 *  double-click target). */
export async function effectiveSelected(
  mime: string,
): Promise<{ appId: string; decl: AppFileHandlerDeclaration } | null> {
  return resolveSelected(mime, await allInstalledManifests());
}

async function resolveSelected(
  mime: string,
  manifests: AppManifest[],
): Promise<{ appId: string; decl: AppFileHandlerDeclaration } | null> {
  const candidates = manifests
    .map((m) => ({ manifest: m, decl: declarationFor(m, mime) }))
    .filter((c): c is { manifest: AppManifest; decl: AppFileHandlerDeclaration } => !!c.decl && canRender(c.decl));

  const chosenId = (await readSelection())[baseMime(mime)];
  const chosen = chosenId ? candidates.find((c) => c.manifest.id === chosenId) : undefined;
  const fallback = candidates.find((c) => c.decl.default === true);
  const winner = chosen ?? fallback;
  return winner ? { appId: winner.manifest.id, decl: winner.decl } : null;
}
