// kb_request_access / kb_access_status: the only tools a token-less session can use before it is
// granted anything. They touch the DB only (never the vault).
import { z } from "zod";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { accessLimits, AccessError, accessStatus, createAccessRequest, MAX_REASON_CHARS, requestedOf } from "../access";
import { formatScope } from "../cli/token";
import { Gate, projectArg, RegisterTool, registerKbTool, spaceArg, toolError, toolText, auditedCall } from "./common";

const SESSION_ONLY = "This tool is only for sessions connected without a token; your token already defines your access.";
const sessionGate: Gate = (ctx) => (ctx.session ? undefined : { result: "error", message: SESSION_ONLY, detail: "not a token-less session" });
const INVALID_REQUEST_ID = "Invalid request_id.";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const register: RegisterTool = (server) => {
  registerKbTool(
    server,
    "kb_request_access",
    {
      description:
        "Ask the user for access to a project when you are connected without a token, or for more access when you already have some (another project, read to write, explicit scopes). Give the space and project you work on, " +
        "read or write, and a clear reason. Nothing is granted until the user approves the request in the admin web; " +
        "then check kb_access_status. Returns a request id and a short code the user matches in the admin.",
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
                `Request id: ${request.id}\nCode: ${request.code}\n` +
                `Ask the user to approve it in the admin web (Access requests page; they can match the code), then call kb_access_status with this request_id. ` +
                `The request expires in ${mins} minutes.`,
            ),
            audit: { detail: `${created ? "request" : "repeat"} ${access ?? "scopes"} ${request.id} code ${request.code}` },
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
        "Check an access request made with kb_request_access: pending, approved (with the granted scopes), denied or expired.",
      inputSchema: { request_id: z.string().max(64, "too long").describe("Request id returned by kb_request_access") },
    },
    async ({ request_id }): Promise<CallToolResult> =>
      auditedCall("kb_access_status", {}, sessionGate, async (ctx) => {
        if (!UUID_RE.test(request_id)) return { toolResult: toolError(INVALID_REQUEST_ID), audit: { detail: "invalid request id" } };
        const st = accessStatus(ctx.session!.id, request_id);
        if (!st) return { toolResult: toolError("Unknown request_id for this session."), audit: { detail: "unknown request" } };
        const lines: Record<string, string> = {
          pending: "pending: the user has not decided yet. Ask them to approve it in the admin web, then check again.",
          approved: "approved: you now have access. Retry your kb_* calls.",
          denied: "denied: the user refused this request. Do not retry unless they ask you to.",
          expired: "expired: nobody decided in time. Call kb_request_access again if you still need access.",
          revoked: "revoked: this access was withdrawn by the user.",
        };
        const scopes = st.scopes?.length ? `\nScopes: ${st.scopes.map(formatScope).join(", ")}` : "";
        return { toolResult: toolText(lines[st.status] + scopes), audit: { detail: `${request_id} ${st.status}` } };
      }),
  );
};
