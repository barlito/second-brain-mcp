// Public SSE on the MCP host: `GET /access-requests/:id/events` tells a `curl -sN` running in an agent's
// background shell when the user decided. The payload is only the status word; the request id (a random
// UUID the requesting agent holds) is the sole capability, and unknown/malformed ids look the same.
import type { Express, Request, Response } from "express";
import { accessLimits, clampTimer, isTerminal, UUID_RE, watchRequest } from "./access";
import { ipKey, RateLimiter } from "./rateLimit";
import { SlotLimiter } from "./slotLimiter";
import { SseStream, startSse } from "./sse";

export const MAX_STREAMS_TOTAL = 200;
export const MAX_STREAMS_PER_IP = 10;
export const STREAMS_PER_MIN_PER_IP = 30;
export const HEARTBEAT_MS = 25_000;

export interface AccessEventsOptions {
  heartbeatMs?: number;
  streamsPerMin?: number;
  isShuttingDown?: () => boolean;
}

export function mountAccessEvents(app: Express, opts: AccessEventsOptions = {}): void {
  const limiter = new RateLimiter(opts.streamsPerMin ?? STREAMS_PER_MIN_PER_IP, 60_000);
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
  const slots = new SlotLimiter(MAX_STREAMS_TOTAL);

  app.get("/access-requests/:id/events", (req: Request, res: Response) => {
    if (opts.isShuttingDown?.()) return void res.status(503).send("Shutting down");
    const key = ipKey(req.ip);
    if (!limiter.hit(key)) return void res.status(429).send("Too many requests");
    const release = slots.acquire([[key, MAX_STREAMS_PER_IP]]);
    if (!release) return void res.status(429).send("Too many requests");

    const id = req.params.id as string;
    let stream: SseStream | undefined;
    const watch = UUID_RE.test(id)
      ? watchRequest(
          id,
          (word) => {
            stream?.send("status", word);
            if (isTerminal(word)) stream?.end();
          },
          () => stream?.end(),
        )
      : null;
    if (!watch) {
      release();
      return void res.status(404).send("Not found");
    }

    const ttl = setTimeout(() => stream?.end(), clampTimer(accessLimits().ttlMs));
    stream = startSse(res, heartbeatMs, () => {
      clearTimeout(ttl);
      watch.stop();
      release();
    });
    stream.send("status", watch.word);
    if (isTerminal(watch.word)) stream.end();
  });
}
