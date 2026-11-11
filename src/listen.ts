import type { Server } from "node:http";
import type { Express } from "express";

// Rejects on listen errors (EADDRINUSE, EACCES, ...): Express 5 hands them to
// the callback. `host` limits the bind address (default: all interfaces).
export function listen(app: Express, port: number, host?: string): Promise<Server> {
  return new Promise<Server>((resolve, reject) => {
    const cb = (err?: Error): void => (err ? reject(err) : resolve(s));
    const s = host === undefined ? app.listen(port, cb) : app.listen(port, host, cb);
  });
}
