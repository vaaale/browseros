import "server-only";
import { randomBytes, createHash, scrypt as scryptCallback, timingSafeEqual } from "crypto";
import { promisify } from "util";
import { getSecretsStore } from "@/lib/integrations/secrets/store";
import { writeIndexEntry, removeIndexEntry } from "./credentials-index";

// Generic, per-user, per-service secret mechanism (034-secrets-authentication,
// FR-001/FR-002). Any BOS server-side feature mints its own scoped, revocable
// credential by calling createSecret(service, label) under a `service`
// namespace of its own choosing — no protocol-specific code lives here.
//
// Reuses the existing encrypted per-user key/value store
// (src/lib/integrations/secrets/store.ts, AES-256-GCM at rest) instead of
// introducing a second encrypted store, per plan.md. All entries for every
// service share one fixed SecretsStore `integrationId` ("service-secrets");
// the `service` namespace lives in the `name` portion as `${service}:${secretId}`
// — `service` itself is therefore restricted from containing ":" (see
// assertValidService), the same restriction SecretsStore places on integrationId.

const scrypt = promisify(scryptCallback);

const NAMESPACE = "service-secrets";
const RAW_SECRET_BYTES = 32; // 256 bits of entropy — see plan.md Assumptions re: unsalted index hash safety
const SALT_BYTES = 16;
const SCRYPT_KEYLEN = 64;

export interface ServiceSecretMetadata {
  secretId: string;
  service: string;
  label?: string;
  createdAt: string;
}

export interface CreatedServiceSecret extends ServiceSecretMetadata {
  /** The raw secret value — returned only once, at creation. */
  rawSecret: string;
}

interface StoredSecret extends ServiceSecretMetadata {
  /** Salted, slow (scrypt) hash of the raw secret, hex-encoded. Authoritative. */
  hash: string;
  /** Hex salt used for `hash`. */
  salt: string;
  /** sha256(rawSecret) hex — kept only so revokeSecret can remove the matching
   *  credentials-index entry without ever persisting the raw secret itself. */
  indexHash: string;
}

// `service` becomes a literal prefix of the storage key (see servicePrefix
// below); a colon in `service` itself would let e.g. service "a:b" match the
// prefix scan for service "a" ("a:" is a prefix of "a:b:..."), breaking
// namespace isolation (FR-001's core guarantee). Reject it the same way
// SecretsStore.makeKey already rejects a colon in `integrationId`.
function assertValidService(service: string): void {
  if (service.includes(":")) throw new Error(`service cannot contain ":": ${service}`);
}

function storageName(service: string, secretId: string): string {
  return `${service}:${secretId}`;
}

function servicePrefix(service: string): string {
  return `${service}:`;
}

function fastHash(rawSecret: string): string {
  return createHash("sha256").update(rawSecret, "utf8").digest("hex");
}

async function slowHash(rawSecret: string, salt: Buffer): Promise<Buffer> {
  return (await scrypt(rawSecret, salt, SCRYPT_KEYLEN)) as Buffer;
}

function toMetadata(stored: StoredSecret): ServiceSecretMetadata {
  return { secretId: stored.secretId, service: stored.service, label: stored.label, createdAt: stored.createdAt };
}

/** Mint a new secret under `service`. The raw value is shown here once and
 *  never persisted or retrievable again — only its hashes are stored. */
export async function createSecret(service: string, label?: string): Promise<CreatedServiceSecret> {
  assertValidService(service);
  const secretId = randomBytes(16).toString("hex");
  const rawSecret = randomBytes(RAW_SECRET_BYTES).toString("base64url");
  const salt = randomBytes(SALT_BYTES);
  const hash = (await slowHash(rawSecret, salt)).toString("hex");
  const indexHash = fastHash(rawSecret);
  const createdAt = new Date().toISOString();

  const stored: StoredSecret = { secretId, service, label, createdAt, hash, salt: salt.toString("hex"), indexHash };
  await getSecretsStore().set(NAMESPACE, storageName(service, secretId), stored);
  await writeIndexEntry(indexHash, service);

  return { secretId, service, label, createdAt, rawSecret };
}

/** Verify a presented candidate against every secret minted for `service`.
 *  Rejects (throws) if none match — including a secret minted for a
 *  different `service` namespace. */
export async function verifySecret(service: string, candidate: string): Promise<ServiceSecretMetadata> {
  assertValidService(service);
  const store = getSecretsStore();
  const prefix = servicePrefix(service);
  const keys = (await store.listKeys(NAMESPACE)).filter((k) => k.startsWith(prefix));

  for (const key of keys) {
    const stored = await store.get<StoredSecret>(NAMESPACE, key);
    if (!stored) continue;
    const candidateHash = await slowHash(candidate, Buffer.from(stored.salt, "hex"));
    const storedHash = Buffer.from(stored.hash, "hex");
    if (candidateHash.length === storedHash.length && timingSafeEqual(candidateHash, storedHash)) {
      return toMetadata(stored);
    }
  }
  throw new Error(`No matching secret for service "${service}"`);
}

/** List metadata for every secret under `service` — never the raw value or
 *  either hash. */
export async function listSecrets(service: string): Promise<ServiceSecretMetadata[]> {
  assertValidService(service);
  const store = getSecretsStore();
  const prefix = servicePrefix(service);
  const keys = (await store.listKeys(NAMESPACE)).filter((k) => k.startsWith(prefix));

  const results: ServiceSecretMetadata[] = [];
  for (const key of keys) {
    const stored = await store.get<StoredSecret>(NAMESPACE, key);
    if (stored) results.push(toMetadata(stored));
  }
  return results;
}

/** Remove a secret's authoritative record and its credentials-index entry
 *  (FR-009). A no-op if `secretId` doesn't exist under `service`. */
export async function revokeSecret(service: string, secretId: string): Promise<void> {
  assertValidService(service);
  const store = getSecretsStore();
  const key = storageName(service, secretId);
  const stored = await store.get<StoredSecret>(NAMESPACE, key);
  if (!stored) return;
  await store.delete(NAMESPACE, key);
  await removeIndexEntry(stored.indexHash);
}

/** Whether `service` has any secret at all. */
export async function hasAnySecret(service: string): Promise<boolean> {
  assertValidService(service);
  const store = getSecretsStore();
  const prefix = servicePrefix(service);
  return (await store.listKeys(NAMESPACE)).some((k) => k.startsWith(prefix));
}
