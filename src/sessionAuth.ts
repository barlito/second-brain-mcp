// Auth for /mcp requests that carry NO Authorization header: a server-issued Mcp-Session-Id.
// This is the only unauthenticated surface, so it is deliberately narrow:
//  - POST only (GET/DELETE fall through to the 405 handlers, never a 401: a 401 would send
//    token-less clients into OAuth discovery);
//  - a small body cap, parsed before anything else happens;
//  - an allowlist of JSON-RPC methods; the rest is refused before a session is even looked up;
//  - no vault access beyond the read-only SESSION_BASELINE_SCOPES (default none): tools/call is
//    fenced centrally (tools/common auditedCall) until a grant or a baseline scope exists.
import express, { NextFunction, Request, Response } from "express";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { TokenContext, tokenContextStorage } from "./auth/context";
import { clientSlug, countGrantlessSessions, createSession, evictGrantlessSession, lookupSession, LiveSession } from "./auth/sessions";
import { logAudit } from "./audit";
import { auditAuthFailure } from "./authFailure";
import { CONNECTOR_HEADER, checkConnectorKey } from "./auth/connectorKeys";
import { Scope } from "./auth/types";
import { AnonLimits, ipKey, RateLimiter } from "./rateLimit";
import { redact } from "./vault/git";

export const ANON_BODY_LIMIT = "32kb";
export const SESSION_HEADER = "mcp-session-id";
// tools/call is allowed here only because every tool is then gated per call.
const ALLOWED_METHODS = new Set(["initialize", "ping", "tools/list", "tools/call"]);

const rpcError = (res: Response, status: number, code: number, message: string): void =>
  void res.status(status).json({ jsonrpc: "2.0", error: { code, message }, id: null });

// `baseline`: read scopes every session holds without approval (SESSION_BASELINE_SCOPES).
function contextFor(s: LiveSession, ip: string | undefined, requests: RateLimiter, baseline: Scope[]): TokenContext {
  const last = s.grants[s.grants.length - 1];
  return {
    tokenId: last?.tokenId ?? `session:${s.id}`,
    name: last?.name ?? `session-${clientSlug(s.clientName)}`,
    scopes: [...baseline, ...s.grants.flatMap((g) => g.scopes)],
    clientIp: ip,
    session: { id: s.id, clientName: s.clientName, grants: s.grants, allowRequest: () => requests.hit(ipKey(ip)) },
  };
}

// Coalescing only (audit rows per client per minute). It never blocks: a request with a valid key must
// not be refused because others fail from the same, possibly shared, address.
export interface FailureLimiter {
  record(ip: string): { audit: boolean; previous: number };
}

export function makeSessionAuth(
  limits: AnonLimits,
  requestLimiter: RateLimiter,
  initLimiter: RateLimiter,
  failures: FailureLimiter,
  baseline: Scope[] = [],
): (req: Request, res: Response, next: NextFunction) => void {
  const parse = express.json({ limit: ANON_BODY_LIMIT });
  // Non-initialize calls: a budget per client and one per session, so a valid session id is no free pass to flood.
  const ipCalls = new RateLimiter(limits.ipCallsPerMin, 60_000);
  const sessionCalls = new RateLimiter(limits.sessionCallsPerMin, 60_000);
  return (req, res, next) => {
    if (req.method !== "POST") return next();
    res.locals.anon = true;
    const ip = req.ip ?? "unknown";
    // Closed by default: no valid connector key (or none exists at all) = 401, before any body parsing,
    // session lookup, rate-limit bucket or audit row other than the coalesced auth-failure one.
    const key = checkConnectorKey(req.headers[CONNECTOR_HEADER.toLowerCase()]);
    if (!key) {
      const { audit, previous } = failures.record(ipKey(ip));
      if (audit) auditAuthFailure(req.ip, previous > 1 ? `missing or invalid connector key (previous minute: ${previous} failures)` : "missing or invalid connector key");
      return void res.status(401).json({ error: "unauthorized" });
    }
    parse(req, res, (err?: unknown) => {
      if (err) return next(err);
      const body: unknown = req.body;
      const msgs = Array.isArray(body) ? body : [body];
      const valid = msgs.length > 0 && msgs.every((m) => typeof m === "object" && m !== null && !Array.isArray(m) && typeof (m as { method?: unknown }).method === "string");
      if (!valid) return rpcError(res, 400, -32600, "Invalid Request");
      // Anything outside the allowlist is refused before a session is even looked up.
      if (msgs.some((m) => !((m as { method: string }).method.startsWith("notifications/") || ALLOWED_METHODS.has((m as { method: string }).method)))) {
        return rpcError(res, 403, -32601, "Method not available without a token");
      }

      let live: LiveSession;
      if (msgs.some((m) => (m as { method: string }).method === "initialize")) {
        if (msgs.length !== 1 || !isInitializeRequest(body)) return rpcError(res, 400, -32600, "Invalid Request: initialize must be a single valid request");
        const ipk = ipKey(ip);
        if (!initLimiter.hit(ipk)) return rpcError(res, 429, -32000, "Too many sessions from this address, retry later");
        // Over a cap: end the most idle grantless session (the client's own first) instead of refusing,
        // so a flood cannot lock legitimate clients out.
        if (countGrantlessSessions(ipk, key.id) >= limits.sessionsPerIp) evictGrantlessSession(ipk, key.id);
        if (countGrantlessSessions() >= limits.maxSessions) evictGrantlessSession();
        const info = (body.params.clientInfo ?? {}) as { name?: unknown; version?: unknown };
        const { sid, id } = createSession({ clientName: info.name, clientVersion: info.version, ip, connectorKeyId: key.id });
        // The client must echo this on every later request; the transport itself stays stateless.
        res.setHeader("Mcp-Session-Id", sid);
        live = lookupSession(sid) as LiveSession;
        try {
          logAudit({ tokenId: `session:${id}`, tokenName: `session-${clientSlug(live.clientName)}`, action: "session_init", result: "ok", detail: `${live.clientName} ${live.clientVersion}`.slice(0, 100), clientIp: ip });
        } catch (err) {
          console.error("session audit write failed:", redact(String(err)));
        }
      } else {
        if (!ipCalls.hit(ipKey(ip))) return rpcError(res, 429, -32000, "Too many requests from this address, retry later");
        const sid = req.headers[SESSION_HEADER];
        if (typeof sid !== "string" || sid === "") return rpcError(res, 400, -32000, "Bad Request: Mcp-Session-Id header is required");
        const found = sid.length > 128 ? null : lookupSession(sid);
        // 404 = unknown/expired/revoked: the spec tells the client to re-initialize.
        // A session only answers to the key that opened it.
        if (!found || found.connectorKeyId !== key.id) return rpcError(res, 404, -32001, "Session not found");
        if (!sessionCalls.hit(found.id)) return rpcError(res, 429, -32000, "Too many requests for this session, retry later");
        live = found;
      }

      const ctx = contextFor(live, req.ip, requestLimiter, baseline);
      res.locals.tokenContext = ctx;
      tokenContextStorage.run(ctx, next);
    });
  };
}
