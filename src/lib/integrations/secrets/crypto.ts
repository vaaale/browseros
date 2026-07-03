import "server-only";
import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

// AES-256-GCM with 96-bit IV + 128-bit auth tag. Per-secret random IV. Node's
// built-in crypto module — no third-party deps. Do NOT use createCipher (no IV,
// deprecated).

const ALGO = "aes-256-gcm";
const IV_BYTES = 12;

export interface Sealed {
  /** Base64url-encoded 12-byte IV. */
  iv: string;
  /** Base64url-encoded ciphertext. */
  ciphertext: string;
  /** Base64url-encoded 16-byte auth tag. */
  tag: string;
}

function toB64Url(b: Buffer): string {
  return b.toString("base64url");
}

function fromB64Url(s: string): Buffer {
  return Buffer.from(s, "base64url");
}

export function encrypt(plaintext: string, key: Buffer): Sealed {
  if (key.length !== 32) throw new Error("encrypt: key must be 32 bytes");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { iv: toB64Url(iv), ciphertext: toB64Url(enc), tag: toB64Url(tag) };
}

export function decrypt(sealed: Sealed, key: Buffer): string {
  if (key.length !== 32) throw new Error("decrypt: key must be 32 bytes");
  const iv = fromB64Url(sealed.iv);
  const tag = fromB64Url(sealed.tag);
  const ct = fromB64Url(sealed.ciphertext);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(ct), decipher.final()]);
  return dec.toString("utf8");
}
