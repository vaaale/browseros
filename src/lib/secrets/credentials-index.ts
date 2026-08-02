import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { dataDir } from "@/os/data-dir";
import { writeFileAtomic } from "@/os/atomic-write";

// The Bastion routing companion index (034-secrets-authentication). A single
// plaintext JSON file per user at data/system/credentials-index.json, mapping
// a FAST, unsalted sha256(rawSecret) hex to which `service` it belongs to.
// This is deliberately a different hash than service-secrets.ts's slow,
// salted authoritative hash — see plan.md's Data Model for why: Bastion needs
// to compute one hash per incoming request and do an O(1) lookup across every
// provisioned user's index, which only works with a fast, deterministic hash.
// This file is never the sole source of truth for authentication (FR-011) —
// it only tells a caller which user/service a credential might belong to.

export interface CredentialsIndexEntry {
  service: string;
  createdAt: string;
}

export interface CredentialsIndexFile {
  version: 1;
  entries: Record<string, CredentialsIndexEntry>;
}

function emptyIndex(): CredentialsIndexFile {
  return { version: 1, entries: {} };
}

function indexFilePath(): string {
  return path.join(dataDir(), "system", "credentials-index.json");
}

// Serializes the read-modify-write cycle so concurrent writeIndexEntry/
// removeIndexEntry calls within this process don't clobber each other (same
// rationale as SecretsStore's mutex in src/lib/integrations/secrets/store.ts
// — BOS runs as a single Node process per user).
class Mutex {
  private queue: Array<() => void> = [];
  private locked = false;

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return Promise.resolve();
    }
    return new Promise((res) => this.queue.push(res));
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) next();
    else this.locked = false;
  }
}

const mutex = new Mutex();

/** Read the current user's companion index. Missing, empty, or corrupted
 *  files are treated as an empty index rather than thrown. */
export async function readIndex(): Promise<CredentialsIndexFile> {
  try {
    const raw = await fs.readFile(indexFilePath(), "utf8");
    const parsed = JSON.parse(raw) as CredentialsIndexFile;
    if (parsed?.version !== 1 || typeof parsed.entries !== "object" || parsed.entries === null) {
      return emptyIndex();
    }
    return parsed;
  } catch {
    return emptyIndex();
  }
}

/** Add (or overwrite) an entry, preserving every other entry already present.
 *  Written atomically (temp file + rename). */
export async function writeIndexEntry(hash: string, service: string): Promise<void> {
  await mutex.run(async () => {
    const current = await readIndex();
    current.entries[hash] = { service, createdAt: new Date().toISOString() };
    await fs.mkdir(path.dirname(indexFilePath()), { recursive: true });
    await writeFileAtomic(indexFilePath(), JSON.stringify(current, null, 2));
  });
}

/** Remove an entry if present. A no-op (not an error) if the hash isn't in
 *  the index — revocation must be idempotent. */
export async function removeIndexEntry(hash: string): Promise<void> {
  await mutex.run(async () => {
    const current = await readIndex();
    if (!(hash in current.entries)) return;
    delete current.entries[hash];
    await fs.mkdir(path.dirname(indexFilePath()), { recursive: true });
    await writeFileAtomic(indexFilePath(), JSON.stringify(current, null, 2));
  });
}
