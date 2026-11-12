// Page renderers for the web admin UI. Every dynamic value goes through html`` (escaped).
import MarkdownIt from "markdown-it";
import type { InboxListItem, ShownProposal } from "../admin/service";
import type { PendingRequest } from "../access";
import type { ActiveSession } from "../auth/sessions";
import type { TokenListEntry } from "../auth/tokens";
import { formatScope } from "../cli/token";
import { html, raw, SafeHtml } from "./html";

// html:false drops raw HTML in notes; markdown-it's default link validation blocks
// javascript:/vbscript:/data: URLs.
const md = new MarkdownIt({ html: false, linkify: false });

// The one safe renderer (inbox + vault).
export const renderMd = (s: string): SafeHtml => raw(md.render(s));

export interface Ctx {
  user: string;
  csrf: string;
  // Fresh one-time form nonce (consumed on POST).
  nonce: () => string;
}

export interface Banner {
  kind: "ok" | "err" | "warn";
  title: string;
  lines?: string[];
}

export const bannerView = (b?: Banner): SafeHtml | "" =>
  b
    ? html`<div class="banner ${b.kind}" role="${b.kind === "err" ? "alert" : "status"}"><strong>${b.title}</strong>${
        b.lines?.length ? html`<ul>${b.lines.map((l) => html`<li>${l}</li>`)}</ul>` : ""
      }</div>`
    : "";

const NAV: Array<[string, string]> = [
  ["/", "Dashboard"],
  ["/tokens", "Tokens"],
  ["/inbox", "Inbox"],
  ["/access", "Access"],
  ["/vault", "Vault"],
  ["/audit", "Audit"],
];

export function layout(ctx: Ctx, active: string, title: string, body: SafeHtml): SafeHtml {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title} - second-brain admin</title>
<link rel="stylesheet" href="/static/style.css">
<script src="/static/app.js" defer></script>
</head>
<body>
<header><div class="bar">
<span class="brand">second-brain admin</span>
<nav>${NAV.map(([href, label]) => html`<a href="${href}"${href === active ? raw(' aria-current="page"') : ""}>${label}</a>`)}</nav>
<span class="who">signed in as <strong>${ctx.user}</strong></span>
</div></header>
<main>
${body}
</main>
</body>
</html>`;
}

export const csrfField = (ctx: Ctx): SafeHtml =>
  html`<input type="hidden" name="csrf" value="${ctx.csrf}"><input type="hidden" name="nonce" value="${ctx.nonce()}">`;

export const fmtSize = (n: number): string => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KiB`);

// ---- dashboard -------------------------------------------------------------

export interface DashboardData {
  dbOk: boolean;
  vaultOk: boolean;
  hasRemote: boolean;
  branch: string | null;
  unpushed: boolean;
  lastPushOk: boolean | null;
  lastPushAt: string | null;
  lastError: string | null;
  conflictBranches: string[];
  // null: the query failed (shown as n/a)
  activeTokens: number | null;
  pendingProposals: number | null;
  pendingAccess: number | null;
  audit24h: number | null;
}

const status = (ok: boolean, yes = "ok", no = "error"): SafeHtml => html`<span class="badge ${ok ? "ok" : "err"}">${ok ? yes : no}</span>`;

export function dashboardView(ctx: Ctx, d: DashboardData): SafeHtml {
  const push =
    d.lastPushOk === null ? html`<span class="badge">no push yet</span>` : status(d.lastPushOk, "ok", "failed");
  return layout(
    ctx,
    "/",
    "Dashboard",
    html`<h1>Dashboard</h1>
<div class="grid">
<div class="stat"><div class="n">${d.activeTokens ?? "n/a"}</div><div class="l">active tokens</div></div>
<div class="stat"><div class="n">${d.pendingProposals ?? "n/a"}</div><div class="l">pending proposals</div></div>
<div class="stat"><a href="/access"><div class="n">${d.pendingAccess ?? "n/a"}</div><div class="l">pending access requests</div></a></div>
<div class="stat"><div class="n">${d.audit24h ?? "n/a"}</div><div class="l">audit rows, last 24 h</div></div>
</div>
<div class="card"><h2 class="flush">Health</h2>
<p>Database: ${status(d.dbOk)} &nbsp; Vault: ${status(d.vaultOk)}</p></div>
<div class="card"><h2 class="flush">Sync</h2>
<p>Remote: ${d.hasRemote ? html`<span class="badge ok">configured</span>` : html`<span class="badge">none (local repo)</span>`}
&nbsp; Branch: <code>${d.branch ?? "unknown"}</code>
&nbsp; Unpushed commits: ${d.unpushed ? html`<span class="badge warn">yes</span>` : html`<span class="badge ok">no</span>`}</p>
<p>Last push: ${push} ${d.lastPushAt ? html`<span class="muted">${d.lastPushAt}</span>` : ""}</p>
${d.lastError ? html`<p class="muted">Last sync error: ${d.lastError}</p>` : ""}
</div>
<div class="card"><h2 class="flush">Conflict branches</h2>
${
  d.conflictBranches.length === 0
    ? html`<p><span class="badge ok">none</span></p>`
    : html`<p><span class="badge err">${d.conflictBranches.length}</span> acknowledged commits were moved aside; resolve them in the vault repo.</p>
<ul>${d.conflictBranches.map((b) => html`<li><code>${b}</code></li>`)}</ul>`
}
</div>`,
  );
}

// ---- tokens ----------------------------------------------------------------

export interface TokenForm {
  name: string;
  scopes: string;
  preset: string;
  allowWildcard: boolean;
  expiresInDays: string;
  project: string;
  dir: string;
}

export function tokensView(ctx: Ctx, tokens: TokenListEntry[], banner?: Banner, form?: TokenForm, projects: string[] = []): SafeHtml {
  const f = form ?? { name: "", scopes: "", preset: "", allowWildcard: false, expiresInDays: "", project: "", dir: "" };
  return layout(
    ctx,
    "/tokens",
    "Tokens",
    html`<h1>Tokens</h1>
${bannerView(banner)}
<div class="scroll"><table>
<thead><tr><th>Name</th><th>Scopes</th><th>Created</th><th>Last used</th><th>Expires</th><th>Status</th><th></th></tr></thead>
<tbody>
${
  tokens.length === 0
    ? html`<tr><td colspan="7" class="muted">No tokens.</td></tr>`
    : tokens.map(
        (t) => html`<tr>
<td>${t.name}${t.kind === "session" ? html` <span class="badge">session</span>` : ""}<br><span class="muted mono">${t.id}</span></td>
<td>${t.scopes.map((s) => html`<div><code>${formatScope(s)}</code></div>`)}</td>
<td class="mono">${t.created_at}</td>
<td class="mono">${t.last_used_at ?? "never"}</td>
<td class="mono">${t.expires_at ?? "never"}</td>
<td>${t.revoked_at ? html`<span class="badge err">revoked</span><br><span class="muted mono">${t.revoked_at}</span>` : t.expired ? html`<span class="badge err">expired</span>` : html`<span class="badge ok">active</span>`}</td>
<td>${
          t.revoked_at
            ? ""
            : html`<form method="post" action="/tokens/${t.id}/revoke" class="inline" data-confirm="Revoke this token? Clients using it will stop working.">${csrfField(ctx)}<button class="danger" type="submit">Revoke</button></form>`
        }</td>
</tr>`,
      )
}
</tbody></table></div>
<h2>Create a token</h2>
<form method="post" action="/tokens" class="card stack">
${csrfField(ctx)}
<label for="name">Name <span class="hint">(1-64 characters; shows up in audit and commit messages)</span></label>
<input type="text" id="name" name="name" maxlength="64" required value="${f.name}">
<label for="preset">Preset <span class="hint">(or list scopes below, not both)</span></label>
<select id="preset" name="preset">
<option value=""${f.preset === "" ? raw(" selected") : ""}>none (use the scopes below)</option>
<option value="master"${f.preset === "master" ? raw(" selected") : ""}>master: read + write everywhere (wildcard)</option>
<option value="master-ro"${f.preset === "master-ro" ? raw(" selected") : ""}>master-ro: read everywhere (wildcard)</option>
<option value="agent"${f.preset === "agent" ? raw(" selected") : ""}>agent: read + write on agents:&lt;name&gt;:* (scopes below are added)</option>
<option value="project"${f.preset === "project" ? raw(" selected") : ""}>project: read meta + one project, write that project (scopes below are added)</option>
</select>
<label for="project">Project <span class="hint">(preset project only: <code>space/project</code>, pick an existing one or type a new one)</span></label>
<input type="text" id="project" name="project" list="projects" maxlength="129" autocomplete="off" spellcheck="false" placeholder="pro/second-brain" value="${f.project}">
<datalist id="projects">${projects.map((p) => html`<option value="${p}"></option>`)}</datalist>
<label for="scopes">Scopes <span class="hint">(one per line: <code>space:project:section:permission</code>; permission is read, write or propose; <code>*</code> only as trailing levels)</span></label>
<textarea id="scopes" name="scopes" spellcheck="false" placeholder="pro:second-brain:*:write">${f.scopes}</textarea>
<label for="expires_in_days">Expires in (days) <span class="hint">(optional, 1-3650; empty = never expires)</span></label>
<input type="text" id="expires_in_days" name="expires_in_days" inputmode="numeric" maxlength="4" value="${f.expiresInDays}">
<label for="dir">Local directory <span class="hint">(optional: the generated Claude Code command starts with <code>cd &lt;dir&gt; &amp;&amp;</code>)</span></label>
<input type="text" id="dir" name="dir" maxlength="512" spellcheck="false" placeholder="~/Project/second-brain-mcp" value="${f.dir}">
<label class="check"><input type="checkbox" name="allow_wildcard" value="1"${f.allowWildcard ? raw(" checked") : ""}> Allow wildcard (required for any <code>*</code> scope or preset; wildcards also cover spaces/projects created later)</label>
<div class="actions"><button class="primary" type="submit">Create token</button></div>
</form>`,
  );
}

export function tokenCreatedView(ctx: Ctx, created: { id: string; name: string; token: string; expires_at?: string | null }, notes: string[], command: string): SafeHtml {
  return layout(
    ctx,
    "/tokens",
    "Token created",
    html`<h1>Token created</h1>
<div class="banner warn" role="alert"><strong>Copy this token now.</strong> It is shown only once, is not stored in plaintext and cannot be retrieved later. Reloading or leaving this page will not show it again.</div>
${notes.length ? html`<div class="banner"><ul>${notes.map((n) => html`<li>${n}</li>`)}</ul></div>` : ""}
<div class="card">
<p>Name: <strong>${created.name}</strong> <span class="muted mono">(${created.id})</span></p>
<p>Expires: <span class="mono">${created.expires_at ?? "never"}</span></p>
<div class="token mono">${created.token}</div>
</div>
<div class="card">
<h2 class="flush">Claude Code</h2>
<p>Run this in a terminal <strong>inside the project directory</strong> (it registers the server for that directory only). Never paste the token into a chat.</p>
<textarea id="claude-cmd" class="cmd" readonly rows="4" spellcheck="false">${command}</textarea>
<div class="actions"><button type="button" class="primary" data-copy="claude-cmd">Copy</button><span class="muted" id="claude-cmd-status" role="status"></span></div>
</div>
<p><a href="/tokens">Back to tokens</a></p>`,
  );
}

// ---- inbox -----------------------------------------------------------------

export function inboxView(ctx: Ctx, list: { proposals: InboxListItem[]; truncated: boolean }, banner?: Banner): SafeHtml {
  return layout(
    ctx,
    "/inbox",
    "Inbox",
    html`<h1>Inbox</h1>
${bannerView(banner)}
${list.truncated ? html`<div class="banner warn">Only the first proposals are listed; resolve some to see the rest.</div>` : ""}
<div class="scroll"><table>
<thead><tr><th>Target</th><th>Proposed by</th><th>Reason</th><th>Created</th><th>Size</th><th></th></tr></thead>
<tbody>
${
  list.proposals.length === 0
    ? html`<tr><td colspan="7" class="muted">No pending proposals.</td></tr>`
    : list.proposals.map(
        (p) => html`<tr>
<td>${p.target ? html`<code>${p.target}</code>` : html`<span class="badge err">malformed</span>`}</td>
<td>${p.proposed_by ?? ""}</td>
<td>${p.reason ?? ""}</td>
<td class="mono">${p.created ?? ""}</td>
<td>${fmtSize(p.size)}</td>
<td><a href="/inbox/${p.id}">Review</a></td>
</tr>`,
      )
}
</tbody></table></div>`,
  );
}

export function proposalView(ctx: Ctx, p: ShownProposal, mode: "rendered" | "raw", banner?: Banner): SafeHtml {
  return layout(
    ctx,
    "/inbox",
    "Proposal",
    html`<h1>Proposal</h1>
${bannerView(banner)}
<div class="card">
<p>Target: <code>${p.target}</code></p>
<p>Proposed by: <strong>${p.proposed_by}</strong> &nbsp; <span class="muted mono">${p.created}</span> &nbsp; <span class="muted">${fmtSize(p.size)}</span></p>
<p>Reason: ${p.reason}</p>
<p class="muted mono">${p.id}</p>
</div>
<div class="tabs">
<a href="/inbox/${p.id}"${mode === "rendered" ? raw(' aria-current="page"') : ""}>Rendered</a>
<a href="/inbox/${p.id}?view=raw"${mode === "raw" ? raw(' aria-current="page"') : ""}>Raw</a>
</div>
<div class="card">${mode === "raw" ? html`<pre>${p.content}</pre>` : html`<div class="md">${raw(md.render(p.content))}</div>`}</div>
<div class="card">
<form method="post" action="/inbox/${p.id}/accept" class="stack" data-confirm="Accept this proposal and commit it to the vault?">
${csrfField(ctx)}
<label class="check"><input type="checkbox" name="overwrite" value="1"> Overwrite the existing target note if there is one</label>
<div class="actions"><button class="primary" type="submit">Accept</button></div>
</form>
<form method="post" action="/inbox/${p.id}/reject" class="actions" data-confirm="Reject and delete this proposal?">
${csrfField(ctx)}
<button class="danger" type="submit">Reject</button>
</form>
</div>
<p><a href="/inbox">Back to inbox</a></p>`,
  );
}

// ---- access requests (token-less sessions) --------------------------------

const ageOf = (iso: string): string => {
  const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
};

export function accessView(ctx: Ctx, pending: PendingRequest[], sessions: ActiveSession[], banner?: Banner): SafeHtml {
  return layout(
    ctx,
    "/access",
    "Access requests",
    html`<h1>Access requests</h1>
${bannerView(banner)}
<p class="muted">Clients connected without a token ask for access to a project. Match the code the agent shows you, adjust the scopes if needed, then approve. Nothing is granted until you do.</p>
${
  pending.length === 0
    ? html`<div class="card"><p class="muted">No pending requests.</p></div>`
    : pending.map(
        (r) => html`<div class="card stack">
<p><span class="badge warn">${r.code}</span> ${r.elevation ? html`<span class="badge err">elevation</span>` : ""} &nbsp; <strong>${r.access}</strong> on <code>${r.space}/${r.project}</code> &nbsp; <span class="muted">${ageOf(r.created_at)}, expires ${r.expires_at}</span></p>
<p>Client: <strong>${r.client_name}</strong> ${r.client_version} &nbsp; IP: <span class="mono">${r.remote_ip ?? "?"}</span></p>
<p>Reason: ${r.reason}</p>
<p>Current grants of this session:${
          r.current_grants.length === 0
            ? html` <span class="muted">none</span>`
            : r.current_grants.map((g) => html`<div><strong>${g.name}</strong>: ${g.scopes.map((sc) => html`<code>${formatScope(sc)}</code> `)}</div>`)
        }</p>
<p>Requested: ${r.requested_scopes.map((sc) => html`<code>${formatScope(sc)}</code> `)}</p>
<form method="post" action="/access/${r.id}/approve" class="stack">
${csrfField(ctx)}
<label for="scopes-${r.id}">Scopes <span class="hint">(one per line; leave as is to grant the default)</span></label>
<textarea id="scopes-${r.id}" name="scopes" spellcheck="false" rows="4">${r.requested_scopes.map(formatScope).join("\n")}</textarea>
<label class="check"><input type="checkbox" name="allow_wildcard" value="1"> Allow wildcard (required for any <code>*</code> scope beyond the default)</label>
<div class="actions"><button class="primary" type="submit">Approve</button></div>
</form>
<form method="post" action="/access/${r.id}/deny" class="actions" data-confirm="Deny this request?">
${csrfField(ctx)}
<button class="danger" type="submit">Deny</button>
</form>
</div>`,
      )
}
<h2>Active sessions</h2>
<div class="scroll"><table>
<thead><tr><th>Client</th><th>Grants</th><th>IP</th><th>Created</th><th>Last seen</th><th></th></tr></thead>
<tbody>
${
  sessions.length === 0
    ? html`<tr><td colspan="6" class="muted">No sessions with access.</td></tr>`
    : sessions.map(
        (s) => html`<tr>
<td>${s.client_name} ${s.client_version}<br><span class="muted mono">${s.id}</span></td>
<td>${s.grants.map((g) => html`<div><strong>${g.name}</strong>${g.scopes.map((sc) => html`<div><code>${formatScope(sc)}</code></div>`)}</div>`)}</td>
<td class="mono">${s.remote_ip ?? ""}</td>
<td class="mono">${s.created_at}</td>
<td class="mono">${s.last_seen_at}</td>
<td><form method="post" action="/access/sessions/${s.id}/revoke" class="inline" data-confirm="Revoke this session? Its access stops immediately.">${csrfField(ctx)}<button class="danger" type="submit">Revoke</button></form></td>
</tr>`,
      )
}
</tbody></table></div>`,
  );
}

export function errorView(ctx: Ctx, status: number, message: string): SafeHtml {
  return layout(ctx, "", `Error ${status}`, html`<h1>Error ${status}</h1><div class="banner err" role="alert">${message}</div><p><a href="/">Dashboard</a></p>`);
}
