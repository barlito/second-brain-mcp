import { AsyncLocalStorage } from "node:async_hooks";
import { Scope } from "./types";

// An approved access grant of a token-less session (a tokens row with kind='session').
export interface SessionGrant {
  tokenId: string;
  name: string;
  scopes: Scope[];
}

export interface SessionInfo {
  id: string; // internal row id, safe to log (NOT the secret Mcp-Session-Id)
  clientName: string;
  grants: SessionGrant[];
  // Per-IP budget for access requests; false = over the limit.
  allowRequest?: () => boolean;
}

export interface TokenContext {
  tokenId: string;
  name: string;
  // For a session: the union of its grants' scopes.
  scopes: Scope[];
  clientIp?: string;
  session?: SessionInfo;
}

// Holds the verified token's context for the duration of a request. Set by
// the auth middleware in server.ts, read by MCP tool handlers deeper
// in the async chain.
export const tokenContextStorage = new AsyncLocalStorage<TokenContext>();

// Fails loudly rather than silently returning undefined — if this ever
// throws, the auth middleware isn't wired correctly for that code path.
export function getTokenContext(): TokenContext {
  const ctx = tokenContextStorage.getStore();
  if (!ctx) {
    throw new Error(
      "getTokenContext() called outside a request context — auth middleware not wired correctly",
    );
  }
  return ctx;
}

const lvl = (scope: string, wanted: string | undefined): boolean => wanted === undefined || scope === "*" || scope === wanted;

// For a session with several grants, attribute the call (audit row, commit message) to the
// grant that covers the target, so a write to project B is not signed with project A's grant.
// Scopes stay the union: this only picks the identity, never widens access.
export function attribute(ctx: TokenContext, target: { space?: string; project?: string; section?: string }): TokenContext {
  const grants = ctx.session?.grants;
  if (!grants || grants.length === 0) return ctx;
  const covers = (g: SessionGrant, specific: boolean): boolean =>
    g.scopes.some((s) => lvl(s.space, target.space) && lvl(s.project, target.project) && lvl(s.section, target.section) && (!specific || s.project !== "*"));
  const g = grants.find((x) => covers(x, true)) ?? grants.find((x) => covers(x, false)) ?? grants[0];
  return g.tokenId === ctx.tokenId ? ctx : { ...ctx, tokenId: g.tokenId, name: g.name };
}
