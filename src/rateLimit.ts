import net from "node:net";

// Rate-limit/cap key of a client address: IPv4 as is, IPv6 bucketed by /64 (one customer holds a
// whole /64, so per-address keys would be free to rotate).
export function ipKey(ip: string | undefined): string {
  if (!ip) return "unknown";
  const v4 = ip.startsWith("::ffff:") && net.isIPv4(ip.slice(7)) ? ip.slice(7) : ip;
  if (!net.isIPv6(v4)) return v4;
  const [head, tail = ""] = v4.split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const groups = v4.includes("::") ? [...h, ...Array<string>(8 - h.length - t.length).fill("0"), ...t] : h;
  return `${groups.slice(0, 4).map((g) => g.toLowerCase().replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

// One audit row per key per window, with a count of what was swallowed (like AuthFailureLimiter).
export class Coalescer {
  private readonly map = new Map<string, { start: number; count: number }>();
  constructor(
    private readonly windowMs = 60_000,
    private readonly maxEntries = 10_000,
    private readonly now: () => number = Date.now,
  ) {}
  // audit=true for the first event of a window; `previous` = events swallowed in the window that just ended.
  hit(key: string): { audit: boolean; previous: number } {
    const t = this.now();
    const e = this.map.get(key);
    if (e && t - e.start < this.windowMs) {
      e.count++;
      return { audit: false, previous: 0 };
    }
    this.map.delete(key);
    this.map.set(key, { start: t, count: 1 });
    while (this.map.size > this.maxEntries) this.map.delete(this.map.keys().next().value as string);
    return { audit: true, previous: e ? e.count - 1 : 0 };
  }
}

// Fixed-window per-key counter (in memory, reset on restart). Bounded: the oldest keys are
// evicted first, so a spray of distinct keys cannot grow it without limit.
export class RateLimiter {
  private readonly map = new Map<string, { start: number; count: number }>();

  constructor(
    readonly max: number,
    private readonly windowMs: number,
    private readonly maxEntries = 10_000,
    private readonly now: () => number = Date.now,
  ) {}

  // Consumes one unit; false when the key is over its budget for this window.
  hit(key: string): boolean {
    const t = this.now();
    const e = this.map.get(key);
    if (e && t - e.start < this.windowMs) {
      e.count++;
      return e.count <= this.max;
    }
    this.map.delete(key); // re-insert so eviction order follows window starts
    this.map.set(key, { start: t, count: 1 });
    while (this.map.size > this.maxEntries) this.map.delete(this.map.keys().next().value as string);
    return this.max >= 1;
  }
}

// Global cap on log lines per window; what is swallowed is reported once, as a count, in the next window.
export class GlobalBudget {
  private start = 0;
  private used = 0;
  private swallowed = 0;
  constructor(
    private readonly max: number,
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}
  take(): { log: boolean; summary: number } {
    const t = this.now();
    let summary = 0;
    if (t - this.start >= this.windowMs) {
      summary = this.swallowed;
      this.start = t;
      this.used = 0;
      this.swallowed = 0;
    }
    if (this.used < this.max) {
      this.used++;
      return { log: true, summary };
    }
    this.swallowed++;
    return { log: false, summary };
  }
}

const posInt = (v: string | undefined, d: number): number => (v && Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : d);

export interface AnonLimits {
  initPerMin: number;
  requestsPerHour: number;
  maxSessions: number; // live sessions without any grant (oldest-idle is evicted beyond it)
  sessionsPerIp: number; // same, per client (IPv6 by /64)
  sessionCallsPerMin: number; // non-initialize token-less requests per session
  ipCallsPerMin: number; // same, per client
  grantlessMaxMs: number; // absolute lifetime of a session that never got a grant
}

export function anonLimits(env: NodeJS.ProcessEnv = process.env): AnonLimits {
  return {
    initPerMin: posInt(env.ANON_INIT_PER_MIN, 10),
    requestsPerHour: posInt(env.ANON_ACCESS_REQUESTS_PER_HOUR, 10),
    maxSessions: posInt(env.ANON_MAX_SESSIONS, 1000),
    sessionsPerIp: posInt(env.ANON_MAX_SESSIONS_PER_IP, 20),
    sessionCallsPerMin: posInt(env.ANON_SESSION_CALLS_PER_MIN, 120),
    ipCallsPerMin: posInt(env.ANON_IP_CALLS_PER_MIN, 600),
    grantlessMaxMs: posInt(env.ANON_SESSION_MAX_HOURS, 2) * 3_600_000,
  };
}
