import { promises as fs } from "fs";
import path from "path";
import { createHash } from "crypto";

// Bastion's protocol-agnostic credential routing (034-secrets-authentication,
// FR-005/FR-006). Resolves a presented raw secret to the user's container it
// belongs to purely by hashing it and scanning every provisioned user's
// credentials-index.json — never by asking the configured identity provider
// who owns it, and never by hardcoding a per-protocol path. See plan.md's
// "Routing Flow" for the full picture; this module is only the lookup.

export interface ResolvedCredential {
  username: string;
  service: string;
}

interface CredentialsIndexEntry {
  service: string;
  createdAt: string;
}

interface CredentialsIndexFile {
  version: 1;
  entries: Record<string, CredentialsIndexEntry>;
}

// Matches config.ts's `volumeBase` fixed convention (always "/user-data",
// never an env var — see config.ts). Callers that already have a `Config`
// should pass `cfg.volumeBase` explicitly; this default only covers the case
// where none is available (e.g. this module used standalone).
const DEFAULT_USERS_ROOT = "/user-data";

function indexFilePath(usersRoot: string, username: string): string {
  return path.join(usersRoot, username, "data", "system", "credentials-index.json");
}

/** Resolve which user's container a presented raw secret belongs to.
 *
 * Enumerates every directory under `usersRoot` (one per provisioned
 * username), reads each one's companion credentials-index.json, and looks up
 * `sha256(rawSecret)` in its entries. Returns the first match's directory
 * name as `username`, plus the `service` that minted it. Returns `null` if no
 * provisioned user's index has a matching entry.
 *
 * A missing or corrupted index for one user (or a users-root that can't be
 * read at all) must never throw and must never prevent other users from
 * being checked — each user's read is independently best-effort. */
export async function resolveCredential(
  rawSecret: string,
  usersRoot: string = DEFAULT_USERS_ROOT,
): Promise<ResolvedCredential | null> {
  const hash = createHash("sha256").update(rawSecret, "utf8").digest("hex");

  let entries: string[];
  try {
    entries = (await fs.readdir(usersRoot, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return null;
  }

  for (const username of entries) {
    try {
      const raw = await fs.readFile(indexFilePath(usersRoot, username), "utf8");
      const parsed = JSON.parse(raw) as CredentialsIndexFile;
      const match = parsed?.entries?.[hash];
      if (match) return { username, service: match.service };
    } catch {
      // Missing or corrupted index for this user — skip it, keep scanning.
      continue;
    }
  }
  return null;
}
