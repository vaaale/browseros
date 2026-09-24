// 045 T005 — the method registry (FR-003a).
//
// A process-wide table of available methods. Packs register at install and
// unregister at uninstall (T024); the built-in spec-kit descriptor registers at
// boot (T006a). Deliberately not `server-only`: the registry itself is plain
// data, and keeping it importable from a test without the server graph is
// worth more than a marker import.

import path from "path";
import { METHOD_SCHEMA_VERSION, type MethodDescriptor } from "./types";

const methods = new Map<string, MethodDescriptor>();

/** Absolute path to the directory a method's files live in (templates, agents,
 *  skills). Recorded at registration because the descriptor's own `templates`
 *  / `agentsDir` are pack-RELATIVE — the same descriptor has to work whether it
 *  is read from BOS's tree or from an installed item, and only the registrar
 *  knows which. */
const packRoots = new Map<string, string>();

export function methodPackRoot(id: string): string | undefined {
  return packRoots.get(id);
}

export class MethodSchemaError extends Error {}

/** Where this method keeps specs inside a user's repository (050 FR-003).
 *
 *  Checked at REGISTRATION, which is the only moment a marketplace pack's
 *  descriptor is read by code that can refuse it. The alternative — and what
 *  happened — is that an omission costs nothing here and produces silence far
 *  away: `detectMethod` skips a pack with no storeRoot, so a repository already
 *  laid out for that framework is never offered it, and registering with the
 *  pack anyway drops the spec store at the repo root.
 *
 *  `"."` is the repo root, said out loud. Refusing absence while accepting an
 *  explicit root is the whole point: "I write beside the code" and "I forgot to
 *  say" are different claims and must not share a spelling. */
function assertStoreRoot(descriptor: MethodDescriptor): void {
  const root = descriptor.storeRoot;
  if (typeof root !== "string" || !root.trim()) {
    throw new MethodSchemaError(
      `Method "${descriptor.id}" does not declare storeRoot — where its specs live inside a repository. ` +
        `Use a path relative to the repo root (e.g. "specs", "openspec", "docs"), or "." if this method writes at the repo root.`,
    );
  }
  if (root !== "." && (path.isAbsolute(root) || root.split(/[\\/]/).includes(".."))) {
    throw new MethodSchemaError(
      `Method "${descriptor.id}" declares storeRoot "${root}", which escapes the repository. ` +
        `It must be a relative path inside the repo, or "." for the repo root.`,
    );
  }
}

/** Register a method, replacing any existing one with the same id (a pack
 *  upgrade re-registers).
 *
 *  REFUSES an unsupported `schemaVersion`, naming both versions. Never
 *  defaults a missing or unrecognised field and continues: a descriptor from a
 *  future schema would otherwise register with fields BOS cannot interpret,
 *  and the first visible symptom is a store that renders empty with no
 *  explanation (SC-015). Failing at registration puts the error where the
 *  cause is. */
export function registerMethod(descriptor: MethodDescriptor, packRoot?: string): void {
  if (descriptor.schemaVersion !== METHOD_SCHEMA_VERSION) {
    throw new MethodSchemaError(
      `Method "${descriptor.id}" declares schemaVersion ${descriptor.schemaVersion}, but this BOS supports ${METHOD_SCHEMA_VERSION}. ` +
        (descriptor.schemaVersion > METHOD_SCHEMA_VERSION
          ? "The pack is newer than BOS — update BOS."
          : "The pack is older than BOS — update the pack."),
    );
  }
  if (!descriptor.id) throw new MethodSchemaError("Method descriptor has no id.");
  // ABSENT and EMPTY are the same failure to a pack author and must report as
  // one. Reading `.length` off an absent key threw a bare "Cannot read
  // properties of undefined", naming neither the pack nor the missing key —
  // the opposite of FR-016's "refuse, naming the mismatch".
  if (!descriptor.phases?.length) throw new MethodSchemaError(`Method "${descriptor.id}" declares no phases.`);
  if (!descriptor.sections?.length) throw new MethodSchemaError(`Method "${descriptor.id}" declares no sections.`);
  assertStoreRoot(descriptor);
  methods.set(descriptor.id, descriptor);
  if (packRoot) packRoots.set(descriptor.id, packRoot);
}

/** Remove a method. Returns whether one was registered — an uninstall that
 *  no-ops because nothing was registered is a different bug from one that
 *  already ran (same reasoning as unregisterMount). */
export function unregisterMethod(id: string): boolean {
  packRoots.delete(id);
  return methods.delete(id);
}

export function getMethod(id: string): MethodDescriptor | undefined {
  return methods.get(id);
}

export function listMethods(): MethodDescriptor[] {
  return [...methods.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** Test-only: drop everything. Not exported through an index — tests import it
 *  by path so it cannot be reached accidentally from product code. */
export function __resetMethodsForTest(): void {
  methods.clear();
  packRoots.clear();
}
