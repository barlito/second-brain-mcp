import { AsyncLocalStorage } from "node:async_hooks";
import { Scope } from "./tokens";

export interface TokenContext {
  tokenId: string;
  name: string;
  scopes: Scope[];
}

// Holds the verified token's context for the duration of a request. Set by
// the Bearer-auth middleware in server.ts, read by MCP tool handlers deeper
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
