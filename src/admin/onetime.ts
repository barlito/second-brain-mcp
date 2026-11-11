// In-memory one-time store: random id, bound to a user, consumed on first take, expires
// after a TTL, bounded size (oldest evicted). Used for form nonces and flash messages.
import { randomBytes } from "node:crypto";

export class OneTimeStore<T> {
  private readonly m = new Map<string, { value: T; user: string; exp: number }>();

  constructor(
    private readonly ttlMs: number,
    private readonly max: number,
    private readonly now: () => number = Date.now,
  ) {}

  put(value: T, user: string): string {
    const t = this.now();
    for (const [k, e] of this.m) if (e.exp <= t) this.m.delete(k);
    // Map keeps insertion order: the first key is the oldest.
    while (this.m.size >= this.max) this.m.delete(this.m.keys().next().value as string);
    const id = randomBytes(16).toString("hex");
    this.m.set(id, { value, user, exp: t + this.ttlMs });
    return id;
  }

  // Consumed even when the user does not match, so a probe cannot be retried.
  take(id: unknown, user: string): T | undefined {
    if (typeof id !== "string") return undefined;
    const e = this.m.get(id);
    if (!e) return undefined;
    this.m.delete(id);
    return e.exp > this.now() && e.user === user ? e.value : undefined;
  }

  get size(): number {
    return this.m.size;
  }
}
