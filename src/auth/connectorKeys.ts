// Connector keys: a fixed secret header (X-SB-Connector-Key) that a claude.ai custom connector or a
// Claude Code `--header` sends, so the token-less surface is closed to the open internet. Lookup is by
// SHA-256 hash; the plaintext is also kept encrypted at rest (AES-256-GCM, key from ADMIN_WEB_SECRET
// via HKDF) so the admin can reveal it again. Not an identity: it grants nothing by itself, it only
// lets a client open a token-less session.
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, randomUUID } from "node:crypto";
import { db } from "../db";
import { endSession } from "./sessions";

export const CONNECTOR_HEADER = "X-SB-Connector-Key";
const LAST_USED_THROTTLE_MS = 60_000;

const hashKey = (k: string): string => createHash("sha256").update(k).digest("hex");

export interface ConnectorKeyEntry {
  id: string;
  name: string;
  created_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
}

export class ConnectorKeyError extends Error {}

const KEY_INFO = "connector-keys-v1";

// Encryption key derived from the admin secret with its own label (never the secret itself).
const encKey = (secret: string): Buffer => Buffer.from(hkdfSync("sha256", secret, "", KEY_INFO, 32));

// nonce(12) | tag(16) | ciphertext, base64; the row id is bound as additional data.
function seal(plain: string, id: string, secret: string): string {
  const nonce = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", encKey(secret), nonce);
  c.setAAD(Buffer.from(id));
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return Buffer.concat([nonce, c.getAuthTag(), ct]).toString("base64");
}

function unseal(blob: string, id: string, secret: string): string | null {
  try {
    const b = Buffer.from(blob, "base64");
    const d = createDecipheriv("aes-256-gcm", encKey(secret), b.subarray(0, 12));
    d.setAAD(Buffer.from(id));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8");
  } catch {
    return null; // wrong secret or tampered
  }
}

// `secret` = ADMIN_WEB_SECRET; without it the key still works but cannot be revealed later.
export function createConnectorKey(name: unknown, secret?: string): { id: string; name: string; key: string } {
  const n = typeof name === "string" ? name.trim() : "";
  if (n.length < 1 || n.length > 64) throw new ConnectorKeyError("name must be 1-64 characters");
  if (/\p{Cc}|\p{Cf}|\p{Zl}|\p{Zp}/u.test(n)) throw new ConnectorKeyError("name must not contain control, format or newline characters");
  const id = randomUUID();
  const key = `sbk_${randomBytes(32).toString("base64url")}`;
  db.prepare("INSERT INTO connector_keys (id, name, key_hash, key_enc, created_at) VALUES (?, ?, ?, ?, ?)").run(id, n, hashKey(key), secret ? seal(key, id, secret) : null, new Date().toISOString());
  return { id, name: n, key };
}

// The key's identity when it exists and is not revoked; null otherwise (including "no key exists").
export function checkConnectorKey(plain: unknown): { id: string; name: string } | null {
  if (typeof plain !== "string" || plain.length < 8 || plain.length > 200) return null;
  const row = db.prepare("SELECT id, name, revoked_at, last_used_at FROM connector_keys WHERE key_hash = ?").get(hashKey(plain)) as
    | { id: string; name: string; revoked_at: string | null; last_used_at: string | null }
    | undefined;
  if (!row || row.revoked_at) return null;
  const now = Date.now();
  const last = row.last_used_at ? Date.parse(row.last_used_at) : NaN;
  if (Number.isNaN(last) || last > now || now - last >= LAST_USED_THROTTLE_MS) {
    try {
      db.prepare("UPDATE connector_keys SET last_used_at = ? WHERE id = ?").run(new Date(now).toISOString(), row.id);
    } catch {
      /* best effort */
    }
  }
  return { id: row.id, name: row.name };
}

export type Reveal = { status: "ok"; id: string; name: string; key: string } | { status: "missing" } | { status: "undecryptable" };

// Decrypts an active key by id or by (unambiguous) name. "undecryptable": the secret changed or the key
// was created without one; the key itself still authenticates through its hash.
export function revealConnectorKey(ref: { id?: string; name?: string }, secret?: string): Reveal {
  const rows = (ref.id !== undefined
    ? db.prepare("SELECT id, name, key_enc FROM connector_keys WHERE id = ? AND revoked_at IS NULL").all(ref.id)
    : db.prepare("SELECT id, name, key_enc FROM connector_keys WHERE name = ? AND revoked_at IS NULL").all(ref.name ?? "")) as Array<{ id: string; name: string; key_enc: string | null }>;
  if (rows.length !== 1) return { status: rows.length === 0 ? "missing" : "undecryptable" };
  const r = rows[0];
  const key = r.key_enc && secret ? unseal(r.key_enc, r.id, secret) : null;
  return key === null ? { status: "undecryptable" } : { status: "ok", id: r.id, name: r.name, key };
}

export function listConnectorKeys(): ConnectorKeyEntry[] {
  return db.prepare("SELECT id, name, created_at, revoked_at, last_used_at FROM connector_keys ORDER BY created_at, rowid").all() as unknown as ConnectorKeyEntry[];
}

// Revoking ends every session opened through the key (their grants are revoked with them).
export function revokeConnectorKey(id: string): { revoked: boolean; sessions: number } {
  return db.transaction(() => {
    const r = db.prepare("UPDATE connector_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(new Date().toISOString(), id);
    if (r.changes === 0) return { revoked: false, sessions: 0 };
    const ids = db.prepare("SELECT id FROM sessions WHERE connector_key_id = ?").all(id) as Array<{ id: string }>;
    for (const s of ids) endSession(s.id);
    return { revoked: true, sessions: ids.length };
  })();
}
