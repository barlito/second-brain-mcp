// Web Push to the admin's devices when a token-less session raises an access request. Payloads are
// encrypted end to end by web-push (aes128gcm) and carry nothing secret. Sending never throws and
// never blocks the access flow: it is fire-and-forget from the request lifecycle events.
import { randomUUID } from "node:crypto";
import * as webpush from "web-push";
import { db } from "./db";
import { onAccessRequestEvent, requestedOf, type RequestRow } from "./access";
import { seal, unseal } from "./auth/sealed";

export const DEFAULT_PUSH_SUBJECT = "https://github.com/barlito/second-brain-mcp";
export const MAX_SUBSCRIPTIONS = 20;
const SEND_TIMEOUT_MS = 10_000;
const VAPID_LABEL = "vapid-v1";
const VAPID_AAD = "vapid";

export class PushError extends Error {}

export interface PushSubscriptionRow {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  user: string;
  label: string;
  created_at: string;
  last_ok_at: string | null;
}

export type SubscriptionInput = Pick<PushSubscriptionRow, "endpoint" | "p256dh" | "auth" | "label">;

export interface Vapid {
  subject: string;
  publicKey: string;
  privateKey: string;
}

export interface SendOptions {
  ttl: number;
  // Replaces a still-queued message with the same topic (web-push: url-safe, <= 32 chars).
  topic?: string;
  vapid: Vapid;
  timeoutMs: number;
}

export type Sender = (target: Pick<PushSubscriptionRow, "endpoint" | "p256dh" | "auth">, payload: string, opts: SendOptions) => Promise<void>;

export const webPushSender: Sender = async (t, payload, o) => {
  await webpush.sendNotification({ endpoint: t.endpoint, keys: { p256dh: t.p256dh, auth: t.auth } }, payload, {
    TTL: o.ttl,
    topic: o.topic,
    urgency: "high",
    timeout: o.timeoutMs,
    vapidDetails: { subject: o.vapid.subject, publicKey: o.vapid.publicKey, privateKey: o.vapid.privateKey },
  });
};

const B64URL_RE = /^[A-Za-z0-9_-]+$/;
const byteLength = (b64url: string): number => Buffer.from(b64url, "base64url").length;

// Validates what the browser's PushSubscription hands over; messages are admin-facing.
export function parseSubscription(body: Record<string, unknown>): SubscriptionInput {
  const s = (v: unknown): string => (typeof v === "string" ? v : "");
  const endpoint = s(body.endpoint).trim();
  let url: URL | undefined;
  try {
    url = new URL(endpoint);
  } catch {
    /* rejected below */
  }
  if (!url || url.protocol !== "https:" || url.username || url.password || endpoint.length > 1024) throw new PushError("The push endpoint must be an https URL (no credentials) of at most 1024 characters.");
  const p256dh = s(body.p256dh).trim();
  if (!B64URL_RE.test(p256dh) || byteLength(p256dh) !== 65) throw new PushError("Invalid p256dh key.");
  const auth = s(body.auth).trim();
  if (!B64URL_RE.test(auth) || byteLength(auth) !== 16) throw new PushError("Invalid auth secret.");
  const label = s(body.label).trim();
  if (label.length < 1 || label.length > 64) throw new PushError("The device name must be 1-64 characters.");
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(label)) throw new PushError("The device name must not contain control characters.");
  return { endpoint, p256dh, auth, label };
}

export interface PushService {
  publicKey(): string;
  add(input: SubscriptionInput, user: string): PushSubscriptionRow;
  list(): PushSubscriptionRow[];
  remove(id: string): boolean;
  // Resolves with the number of devices reached; never rejects.
  sendToAll(payload: object, ttlSeconds: number, topic?: string): Promise<number>;
}

export interface PushOptions {
  // Seals the VAPID private key (ADMIN_WEB_SECRET, or a per-boot random one that resets devices on restart).
  secret: string;
  subject?: string;
  send?: Sender;
  timeoutMs?: number;
}

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("push send timed out")), ms);
    p.then(resolve, reject).finally(() => clearTimeout(t));
  });

export function createPushService(o: PushOptions): PushService {
  const subject = o.subject || DEFAULT_PUSH_SUBJECT;
  const send = o.send ?? webPushSender;
  const timeoutMs = o.timeoutMs ?? SEND_TIMEOUT_MS;
  let keys: { publicKey: string; privateKey: string } | undefined;

  // Generated on first need. A stored key that cannot be unsealed (secret changed) is replaced, and
  // the subscriptions go with it: they are bound to the old public key.
  function vapid(): { publicKey: string; privateKey: string } {
    if (keys) return keys;
    const row = db.prepare("SELECT public_key, private_key_sealed FROM push_vapid WHERE id = 1").get() as { public_key: string; private_key_sealed: string } | undefined;
    const priv = row ? unseal(row.private_key_sealed, VAPID_AAD, o.secret, VAPID_LABEL) : null;
    if (row && priv !== null) return (keys = { publicKey: row.public_key, privateKey: priv });
    const fresh = webpush.generateVAPIDKeys();
    db.transaction(() => {
      if (row) db.prepare("DELETE FROM push_subscriptions").run();
      db.prepare("INSERT OR REPLACE INTO push_vapid (id, public_key, private_key_sealed, created_at) VALUES (1, ?, ?, ?)").run(
        fresh.publicKey,
        seal(fresh.privateKey, VAPID_AAD, o.secret, VAPID_LABEL),
        new Date().toISOString(),
      );
    })();
    if (row) console.warn("push: stored VAPID key cannot be unsealed (ADMIN_WEB_SECRET changed?): new keypair generated, devices must enable notifications again");
    return (keys = fresh);
  }

  const list = (): PushSubscriptionRow[] => db.prepare("SELECT * FROM push_subscriptions ORDER BY created_at, rowid").all() as unknown as PushSubscriptionRow[];

  function add(input: SubscriptionInput, user: string): PushSubscriptionRow {
    const known = db.prepare("SELECT id FROM push_subscriptions WHERE endpoint = ?").get(input.endpoint) as { id: string } | undefined;
    if (!known && list().length >= MAX_SUBSCRIPTIONS) throw new PushError(`At most ${MAX_SUBSCRIPTIONS} devices: remove one first.`);
    const id = known?.id ?? randomUUID();
    db.prepare(
      `INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, user, label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, user = excluded.user, label = excluded.label`,
    ).run(id, input.endpoint, input.p256dh, input.auth, user, input.label, new Date().toISOString());
    return db.prepare("SELECT * FROM push_subscriptions WHERE id = ?").get(id) as unknown as PushSubscriptionRow;
  }

  async function sendOne(sub: PushSubscriptionRow, body: string, ttl: number, topic: string | undefined, v: Vapid): Promise<boolean> {
    try {
      await withTimeout(send(sub, body, { ttl, topic, vapid: v, timeoutMs }), timeoutMs);
      db.prepare("UPDATE push_subscriptions SET last_ok_at = ? WHERE id = ?").run(new Date().toISOString(), sub.id);
      return true;
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) {
        try {
          db.prepare("DELETE FROM push_subscriptions WHERE id = ?").run(sub.id);
        } catch {
          /* best effort */
        }
        return false;
      }
      // Never the endpoint (a capability URL) nor the error text (it can echo the request).
      console.warn(`push: send to device ${sub.id} failed (${status ?? (err instanceof Error ? err.name : "error")})`);
      return false;
    }
  }

  return {
    publicKey: () => vapid().publicKey,
    add,
    list,
    remove: (id) => db.prepare("DELETE FROM push_subscriptions WHERE id = ?").run(id).changes > 0,
    async sendToAll(payload, ttlSeconds, topic) {
      try {
        if (list().length === 0) return 0;
        const v: Vapid = { subject, ...vapid() }; // may reset the subscriptions: read them afterwards
        const subs = list();
        const body = JSON.stringify(payload);
        const ttl = Math.max(1, Math.floor(ttlSeconds));
        const ok = await Promise.all(subs.map((s) => sendOne(s, body, ttl, topic, v)));
        return ok.filter(Boolean).length;
      } catch (err) {
        console.warn(`push: sending failed (${err instanceof Error ? err.name : "error"})`);
        return 0;
      }
    },
  };
}

// ---- access request notifications ------------------------------------------------------------

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function requestPayload(r: RequestRow, clientName: string): { tag: string; title: string; body: string; url: string } {
  const what = r.space && r.project && r.access ? `${r.access} ${r.space}/${r.project}` : `${requestedOf(r).length} scopes`;
  return {
    tag: r.id,
    title: "Access request",
    body: clip(`${r.elevation ? "Elevation: " : ""}${clientName} · ${what}`, 140),
    url: `/access#req-${r.id}`,
  };
}

// Notifies the devices of each new request; returns the unsubscribe function. Fully guarded: the
// access flow never sees an error from here.
export function attachAccessPush(push: PushService): () => void {
  return onAccessRequestEvent(({ request }) => {
    try {
      const me = db.prepare("SELECT client_name FROM sessions WHERE id = ?").get(request.session_id) as { client_name: string } | undefined;
      const ttl = (Date.parse(request.expires_at) - Date.now()) / 1000;
      void push.sendToAll(requestPayload(request, me?.client_name ?? "unknown client"), ttl, request.id.replace(/-/g, ""));
    } catch (err) {
      console.warn(`push: notification failed (${err instanceof Error ? err.name : "error"})`);
    }
  });
}
