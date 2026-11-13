// Public SSE on the MCP host: `GET /access-requests/:id/events` tells a `curl -sN` running in an agent's
// background shell when the user decided. The payload is only the status word; the request id (a random
// UUID the requesting agent holds) is the sole capability, and unknown/malformed ids look the same.
import type { Express, Request, Response } from "express";
import { accessLimits, isTerminal, requestWord, UUID_RE, watchRequest } from "./access";
import { ipKey, RateLimiter } from "./rateLimit";

export const MAX_STREAMS_TOTAL = 200;
export const MAX_STREAMS_PER_IP = 10;
export const STREAMS_PER_MIN_PER_IP = 30;
export const HEARTBEAT_MS = 25_000;

export interface AccessEventsOptions {
  heartbeatMs?: number;
  streamsPerMin?: number;
}

export function mountAccessEvents(app: Express, opts: AccessEventsOptions = {}): void {
  const limiter = new RateLimiter(opts.streamsPerMin ?? STREAMS_PER_MIN_PER_IP, 60_000);
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
  const perIp = new Map<string, number>();
  let total = 0;

  app.get("/access-requests/:id/events", (req: Request, res: Response) => {
    const id = req.params.id as string;
    const key = ipKey(req.ip);
    if (!limiter.hit(key)) return void res.status(429).send("Too many requests");
    const open = perIp.get(key) ?? 0;
    if (total >= MAX_STREAMS_TOTAL || open >= MAX_STREAMS_PER_IP) return void res.status(429).send("Too many requests");
    if (!UUID_RE.test(id) || requestWord(id) === null) return void res.status(404).send("Not found");

    total++;
    perIp.set(key, open + 1);
    res.status(200).set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" });
    res.flushHeaders();
    res.write("retry: 5000\n\n");

    const beat = setInterval(() => void res.write(": ping\n\n"), heartbeatMs);
    const ttl = setTimeout(() => res.end(), accessLimits().ttlMs);
    let stop = (): void => {};
    let closed = false;
    const onClose = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(beat);
      clearTimeout(ttl);
      stop();
      total--;
      const n = (perIp.get(key) ?? 1) - 1;
      if (n > 0) perIp.set(key, n);
      else perIp.delete(key);
    };
    res.on("close", onClose);
    stop = watchRequest(id, (word) => {
      res.write(`event: status\ndata: ${word}\n\n`);
      if (isTerminal(word)) res.end();
    });
    if (closed) stop();
  });
}
