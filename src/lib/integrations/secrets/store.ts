import "server-only";
import { promises as fs } from "fs";
import { writeFileAtomic } from "@/os/atomic-write";
import { ensureIntegrationsRoot, secretsFile } from "../paths";
import { loadOrCreateKey } from "./keyfile";
import { decrypt, encrypt, type Sealed } from "./crypto";

// SecretsStore — encrypted key/value store keyed by "<integrationId>:<name>".
// Values are arbitrary JSON-serialisable payloads (typically OAuthTokens or
// client_secrets records). File layout is a JSON blob where each key maps to
// a sealed envelope; the plaintext value is JSON-stringified before encryption.
//
// Concurrency: an in-process mutex serialises the read-modify-write cycle so
// two parallel `set(...)` calls with different keys don't clobber each other.
// This is safe because BOS runs as a single Node process; the file itself is
// written via writeFileAtomic (temp + rename) for crash safety.

type StoredKey = `${string}:${string}`;

interface OnDisk {
  version: 1;
  entries: Record<StoredKey, Sealed>;
}

function emptyOnDisk(): OnDisk {
  return { version: 1, entries: {} };
}

function makeKey(integrationId: string, name: string): StoredKey {
  if (integrationId.includes(":")) throw new Error(`integrationId cannot contain ":": ${integrationId}`);
  return `${integrationId}:${name}` as StoredKey;
}

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
    if (next) {
      next();
    } else {
      this.locked = false;
    }
  }
}

export class SecretsStore {
  private readonly mutex = new Mutex();

  private async readAll(): Promise<OnDisk> {
    try {
      const raw = await fs.readFile(secretsFile(), "utf8");
      const parsed = JSON.parse(raw) as OnDisk;
      if (parsed?.version !== 1 || typeof parsed.entries !== "object" || parsed.entries === null) {
        return emptyOnDisk();
      }
      return parsed;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyOnDisk();
      throw err;
    }
  }

  private async writeAll(data: OnDisk): Promise<void> {
    await ensureIntegrationsRoot();
    await writeFileAtomic(secretsFile(), JSON.stringify(data, null, 2));
    await fs.chmod(secretsFile(), 0o600).catch(() => {});
  }

  async set<T>(integrationId: string, name: string, value: T): Promise<void> {
    const key = makeKey(integrationId, name);
    const cryptoKey = await loadOrCreateKey();
    await this.mutex.run(async () => {
      const disk = await this.readAll();
      disk.entries[key] = encrypt(JSON.stringify(value), cryptoKey);
      await this.writeAll(disk);
    });
  }

  async get<T>(integrationId: string, name: string): Promise<T | null> {
    const key = makeKey(integrationId, name);
    const cryptoKey = await loadOrCreateKey();
    const disk = await this.readAll();
    const sealed = disk.entries[key];
    if (!sealed) return null;
    return JSON.parse(decrypt(sealed, cryptoKey)) as T;
  }

  async delete(integrationId: string, name: string): Promise<void> {
    const key = makeKey(integrationId, name);
    await this.mutex.run(async () => {
      const disk = await this.readAll();
      if (key in disk.entries) {
        delete disk.entries[key];
        await this.writeAll(disk);
      }
    });
  }

  /** Return the `name` portion of every key owned by `integrationId`. */
  async listKeys(integrationId: string): Promise<string[]> {
    const disk = await this.readAll();
    const prefix = `${integrationId}:`;
    return Object.keys(disk.entries)
      .filter((k) => k.startsWith(prefix))
      .map((k) => k.slice(prefix.length));
  }
}

let singleton: SecretsStore | undefined;

export function getSecretsStore(): SecretsStore {
  if (!singleton) singleton = new SecretsStore();
  return singleton;
}
