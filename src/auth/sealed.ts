// AES-256-GCM sealing of small secrets at rest. The key is derived from the admin secret with HKDF
// under a per-use label (never the secret itself), so each use has its own key.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

const encKey = (secret: string, label: string): Buffer => Buffer.from(hkdfSync("sha256", secret, "", label, 32));

// nonce(12) | tag(16) | ciphertext, base64; `aad` (e.g. the row id) is bound as additional data.
export function seal(plain: string, aad: string, secret: string, label: string): string {
  const nonce = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", encKey(secret, label), nonce, { authTagLength: 16 });
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return Buffer.concat([nonce, c.getAuthTag(), ct]).toString("base64");
}

export function unseal(blob: string, aad: string, secret: string, label: string): string | null {
  try {
    const b = Buffer.from(blob, "base64");
    if (b.length < 28) return null; // nonce + tag; an empty plaintext still has both
    // Explicit tag length: never accept a truncated tag.
    const d = createDecipheriv("aes-256-gcm", encKey(secret, label), b.subarray(0, 12), { authTagLength: 16 });
    d.setAAD(Buffer.from(aad));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8");
  } catch {
    return null; // wrong secret or tampered
  }
}
