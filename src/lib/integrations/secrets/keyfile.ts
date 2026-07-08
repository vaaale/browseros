import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { randomBytes } from "crypto";
import { keyfilePath } from "../paths";

// AES-256 requires 32 bytes of key material. The keyfile lives at
// data/.integrations-key with mode 0o600. Losing it invalidates every
// stored secret — documented in docs/dev/integrations.md.

const KEY_LEN = 32;

let cached: Buffer | undefined;

/** Load the integrations keyfile, creating a fresh 32-byte key if absent. */
export async function loadOrCreateKey(): Promise<Buffer> {
  if (cached) return cached;
  const p = keyfilePath();
  try {
    const buf = await fs.readFile(p);
    if (buf.length !== KEY_LEN) {
      throw new Error(`Keyfile at ${p} has ${buf.length} bytes, expected ${KEY_LEN}. Delete it to regenerate (all stored secrets will be invalidated).`);
    }
    cached = buf;
    return buf;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const fresh = randomBytes(KEY_LEN);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, fresh, { mode: 0o600 });
  await fs.chmod(p, 0o600).catch(() => {});
  cached = fresh;
  return fresh;
}

/** Test-only: forget the cached key. */
export function _resetKeyCache(): void {
  cached = undefined;
}
