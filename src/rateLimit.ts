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

const posInt = (v: string | undefined, d: number): number => (v && Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : d);

export interface AnonLimits {
  initPerMin: number;
  requestsPerHour: number;
  maxSessions: number; // live sessions without any grant
}

export function anonLimits(env: NodeJS.ProcessEnv = process.env): AnonLimits {
  return {
    initPerMin: posInt(env.ANON_INIT_PER_MIN, 10),
    requestsPerHour: posInt(env.ANON_ACCESS_REQUESTS_PER_HOUR, 10),
    maxSessions: posInt(env.ANON_MAX_SESSIONS, 1000),
  };
}
