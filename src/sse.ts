// Server-sent events plumbing shared by the admin feed and the public access-request stream.
import type { Response } from "express";

export interface SseStream {
  send(event: string, data: string): void;
  // Ends the response; `onClose` runs once, whether the client left or the server ended it.
  end(): void;
}

export function startSse(res: Response, heartbeatMs: number, onClose: () => void): SseStream {
  res.status(200).set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" });
  res.flushHeaders();
  const write = (chunk: string): void => {
    if (!res.writableEnded) res.write(chunk);
  };
  write("retry: 5000\n\n");
  const beat = setInterval(() => write(": ping\n\n"), heartbeatMs);
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(beat);
    onClose();
  };
  res.on("close", close);
  res.on("error", close);
  return {
    send: (event, data) => write(`event: ${event}\ndata: ${data}\n\n`),
    end: () => {
      close();
      res.end();
    },
  };
}
