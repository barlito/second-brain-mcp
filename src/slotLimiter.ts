// Bounded concurrent slots: one global cap plus a cap per key (session, client address...).
export class SlotLimiter {
  private readonly held = new Map<string, number>();
  private total = 0;

  constructor(private readonly maxTotal: number) {}

  // A release function, or undefined when the global cap or any `[key, max]` cap is reached.
  acquire(caps: Array<[string, number]>): (() => void) | undefined {
    if (this.total >= this.maxTotal || caps.some(([key, max]) => (this.held.get(key) ?? 0) >= max)) return undefined;
    this.total++;
    for (const [key] of caps) this.held.set(key, (this.held.get(key) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.total--;
      for (const [key] of caps) {
        const n = (this.held.get(key) ?? 1) - 1;
        if (n > 0) this.held.set(key, n);
        else this.held.delete(key);
      }
    };
  }
}
