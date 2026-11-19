// kb_request_access / kb_access_status / kb_release_access: the only tools a token-less session can use before it is
// granted anything. They touch the DB only (never the vault).
import { z } from "zod";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { accessLimits, AccessError, accessStatus, createAccessRequest, MAX_REASON_CHARS, parseScopeStrings, requestedOf, UUID_RE } from "../access";
import { MAX_WAIT_SECONDS, waitForDecision } from "../accessWait";
import { mcpUrl } from "../mcpCommand";
import { ipKey } from "../rateLimit";
import { listGrants, releaseGrants } from "../auth/sessions";
import { TokenValidationError } from "../auth/tokens";
import { formatScope } from "../cli/token";
import { Gate, projectArg, RegisterTool, registerKbTool, spaceArg, toolError, toolText, auditedCall } from "./common";

const SESSION_ONLY = "This tool is only for sessions connected without a token; your token already defines your access.";
const sessionGate: Gate = (ctx) => (ctx.session ? undefined : { result: "error", message: SESSION_ONLY, detail: "not a token-less session" });
const RELEASE_HINT = "Keep it for the whole conversation while the work may still need it (re-asking means the user approves again). Give it back with kb_release_access only when the user says the work is done or ending, or right after a one-off elevation (e.g. one write on meta); unused sessions expire on their own.";
const WAIT_RULE =
  "Do not wait for the user to come back by message. If you can run a background shell command that notifies you when it exits, run `curl -sN <events URL>` in the background (it ends when the user decides), then call kb_access_status once. " +
  "Otherwise call kb_access_status with wait_seconds=50 again until approved, denied or expired. Then resume the work on your own.";
// Sibling of the /mcp endpoint, so a path prefix in PUBLIC_MCP_URL is kept.
const EVENTS_BASE = mcpUrl().replace(/\/mcp\/?$/, "");
const eventsUrl = (id: string): string => `${EVENTS_BASE}/access-requests/${id}/events`;
const BUSY_NOTE = "\nThe server is busy, so the wait was skipped: call kb_access_status again in about 10 s.";
const INVALID_REQUEST_ID = "Invalid request_id.";

export const register: RegisterTool = (server) => {
  registerKbTool(
    server,
    "kb_request_access",
    {
      description:
        "Ask the user for access when you are connected without a token (kb_* then answer \"No access for this session\"; some read access, usually the meta space, may be open to every session without a request), or for more access when you already have some. " +
        "Do NOT request up front: work without the knowledge base when you do not need it, and call this only when you actually need it. " +
        "Give the space and project you work on, read or write, and a clear reason. Nothing is granted until the user approves the request in the admin web: ask them to. " +
        WAIT_RULE + " " +
        "You can request again later in the same session to get more (another project, read to write, or an explicit scopes list); each approval adds to what you already have, a denial changes nothing. Only the user grants and can revoke access. " +
        "Returns a request id. " +
        RELEASE_HINT,
      inputSchema: {
        space: spaceArg.optional().describe("Space slug (with project and access; optional when scopes is given)"),
        project: projectArg.optional().describe("Project slug"),
        access: z.enum(["read", "write"]).optional().describe("read, or write (which includes read)"),
        scopes: z
          .array(z.string().max(200))
          .max(10)
          .optional()
          .describe("Optional explicit scopes (space:project:section:permission); wildcards need the user's explicit confirmation"),
        reason: z
          .string()
          .trim()
          .min(1, "must not be empty")
          .max(MAX_REASON_CHARS, `too long (max ${MAX_REASON_CHARS} characters)`)
          .describe("Why you need this access, shown to the user"),
      },
    },
    async ({ space, project, access, reason, scopes }): Promise<CallToolResult> =>
      auditedCall("kb_request_access", { space, project }, sessionGate, async (ctx) => {
        try {
          const { request, created } = createAccessRequest(ctx.session!.id, { space, project, access, reason, scopes }, ctx.session!.allowRequest);
          const mins = Math.round(accessLimits().ttlMs / 60_000);
          return {
            toolResult: toolText(
              `Access requested${created ? "" : " (already pending)"}: ${requestedOf(request).map(formatScope).join(", ")}.\n` +
                `Request id: ${request.id}\n` +
                `Ask the user to approve it in the admin web (Access page).\nEvents URL: ${eventsUrl(request.id)}\n${WAIT_RULE} ` +
                `The request expires in ${mins} minutes.`,
            ),
            audit: { detail: `${created ? "request" : "repeat"} ${access ?? "scopes"} ${request.id}` },
          };
        } catch (err) {
          if (err instanceof AccessError) return { toolResult: toolError(err.message), audit: { detail: err.message } };
          throw err;
        }
      }),
  );

  registerKbTool(
    server,
    "kb_access_status",
    {
      description:
        "Check an access request made with kb_request_access: pending, approved (with the granted scopes), denied or expired. With wait_seconds (0-50, default 0) a pending request is held until the user decides or the time is up; a denial changes nothing, only the user grants or revokes access. " +
        RELEASE_HINT,
      inputSchema: {
        request_id: z.string().max(64, "too long").describe("Request id returned by kb_request_access"),
        wait_seconds: z.number().int().min(0).max(MAX_WAIT_SECONDS).optional().describe(`Hold a pending request up to this many seconds (0-${MAX_WAIT_SECONDS}, default 0)`),
      },
    },
    async ({ request_id, wait_seconds }, signal): Promise<CallToolResult> =>
      auditedCall("kb_access_status", {}, sessionGate, async (ctx) => {
        if (!UUID_RE.test(request_id)) return { toolResult: toolError(INVALID_REQUEST_ID), audit: { detail: "invalid request id" } };
        let waited = true;
        let st = accessStatus(ctx.session!.id, request_id);
        if (st?.status === "pending" && wait_seconds) {
          waited = await waitForDecision({ session: ctx.session!.id, ip: ipKey(ctx.clientIp) }, request_id, wait_seconds, signal);
          st = accessStatus(ctx.session!.id, request_id);
        }
        if (!st) return { toolResult: toolError("Unknown request_id for this session."), audit: { detail: "unknown request" } };
        const lines: Record<string, string> = {
          pending: "pending: the user has not decided yet. Ask them to approve it in the admin web, then check again.",
          approved: "approved: you now have access. Retry your kb_* calls.",
          denied: "denied: the user refused this request. Do not retry unless they ask you to.",
          expired: "expired: nobody decided in time. Call kb_request_access again if you still need access.",
          revoked: "revoked: this access was withdrawn by the user.",
        };
        const scopes = st.scopes?.length ? `\nScopes: ${st.scopes.map(formatScope).join(", ")}` : "";
        return { toolResult: toolText(lines[st.status] + scopes + (st.status === "approved" ? `\n${RELEASE_HINT}` : "") + (waited ? "" : BUSY_NOTE)), audit: { detail: `${request_id} ${st.status}` } };
      }),
  );

  registerKbTool(
    server,
    "kb_release_access",
    {
      description:
        "Give back access this session was granted through kb_request_access. Do not release early: keep access for the whole conversation while it may still be needed (re-asking means the user approves again); release when the user says the work is done or ending, or right after a one-off elevation. Idle sessions expire on their own. Without `scopes` it releases ALL your grants; with `scopes` (space:project:section:permission, exact match, no wildcard expansion: meta:*:*:read only matches a held meta:*:*:read) only those. " +
        "Scopes you do not hold are reported as not held, not as an error. A grant left with no scope is revoked, exactly as if the user had revoked it. " +
        "The session stays alive and keeps the baseline read access (e.g. meta), which is not a grant and cannot be released. Only for sessions connected without a token. " +
        "Returns what was released and what remains. Ask again with kb_request_access if you need it later.",
      inputSchema: {
        scopes: z
          .array(z.string().max(200))
          .max(20)
          .optional()
          .describe("Scopes to release (space:project:section:permission); omit to release every grant of this session"),
      },
    },
    async ({ scopes }): Promise<CallToolResult> =>
      auditedCall("kb_release_access", {}, sessionGate, async (ctx) => {
        let wanted;
        if (scopes !== undefined) {
          try {
            if (scopes.length === 0) throw new TokenValidationError("scopes must not be empty (omit it to release everything)");
            wanted = parseScopeStrings(scopes);
          } catch (err) {
            if (err instanceof TokenValidationError) return { toolResult: toolError(err.message), audit: { detail: err.message } };
            throw err;
          }
        }
        const r = releaseGrants(ctx.session!.id, wanted);
        const remaining = [...new Set(listGrants(ctx.session!.id).flatMap((g) => g.scopes.map(formatScope)))];
        const fmt = (l: Array<Parameters<typeof formatScope>[0]>) => l.map(formatScope).join(", ");
        const lines: string[] = [];
        if (r.released.length > 0) lines.push(`Released: ${fmt(r.released)}.`);
        else if (r.notHeld.length === 0) lines.push("You hold no grants: nothing to release.");
        if (r.notHeld.length > 0) lines.push(`Not held: ${fmt(r.notHeld)}.`);
        lines.push(remaining.length > 0 ? `Still granted: ${remaining.join(", ")}.` : "No grants remain. Baseline read access (e.g. meta), if any, is not a grant and stays.");
        lines.push("Ask again with kb_request_access if you need it later.");
        const detail = `released ${r.released.length}: ${fmt(r.released)}${r.notHeld.length ? `; not held: ${fmt(r.notHeld)}` : ""}`;
        return { toolResult: toolText(lines.join("\n")), audit: { detail } };
      }),
  );
};
