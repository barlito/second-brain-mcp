// Token pages: list (server-side filters), new-token form, one-time token display.
// The scope builder is progressive enhancement in /static/app.js; the form works without it.
import type { Scope, TokenListEntry } from "../auth/tokens";
import { formatScope } from "../cli/token";
import { html, raw, SafeHtml } from "./html";
import { Banner, bannerView, csrfField, Ctx, ICON, isWholeVault, layout, pageHead, relTime, scopeChip, scopeDescription, shortDate } from "./views";

export type TokenStatus = "active" | "expired" | "revoked" | "all";
export const TOKEN_STATUSES: TokenStatus[] = ["active", "expired", "revoked", "all"];
const STATUS_LABEL: Record<TokenStatus, string> = { active: "Active", expired: "Expired", revoked: "Revoked", all: "All" };

export const tokenStatusOf = (t: TokenListEntry): Exclude<TokenStatus, "all"> => (t.revoked_at ? "revoked" : t.expired ? "expired" : "active");

export interface TokenListQuery {
  status: TokenStatus;
  q: string;
  showSessions: boolean;
  // Counts per status are computed over the list given to the view (after the sessions filter).
}

const tokensUrl = (o: { status?: TokenStatus; q?: string; sessions?: boolean }): string => {
  const p = new URLSearchParams();
  if (o.status && o.status !== "active") p.set("status", o.status);
  if (o.q) p.set("q", o.q);
  if (o.sessions) p.set("sessions", "1");
  const s = p.toString();
  return `/tokens${s ? `?${s}` : ""}`;
};

// Name, id or any scope (path or permission) containing the text, case-insensitive.
export const tokenMatches = (t: TokenListEntry, q: string): boolean => {
  const n = q.trim().toLowerCase();
  return !n || t.name.toLowerCase().includes(n) || t.id.toLowerCase().includes(n) || t.scopes.some((s) => formatScope(s).toLowerCase().includes(n));
};

export function tokensView(ctx: Ctx, all: TokenListEntry[], query: TokenListQuery, banner?: Banner): SafeHtml {
  const count = (k: TokenStatus): number => (k === "all" ? all.length : all.filter((t) => tokenStatusOf(t) === k).length);
  const q = query.q.trim();
  const rows = all.filter((t) => (query.status === "all" || tokenStatusOf(t) === query.status) && tokenMatches(t, q));
  const hiddenRevoked = query.status === "active" && !q ? count("revoked") : 0;
  return layout(
    ctx,
    "/tokens",
    "Tokens",
    html`${pageHead("Tokens", "API tokens let MCP clients and scripts reach the vault. Each one only sees the scopes you grant it.", html`<a class="btn btn-primary" href="/tokens/new">${ICON.plus}New token</a>`)}
${bannerView(banner)}
<div class="row between g12">
<div class="seg" role="group" aria-label="Filter by status">${TOKEN_STATUSES.map(
      (k) => html`<a href="${tokensUrl({ status: k, q, sessions: query.showSessions })}"${k === query.status ? raw(' aria-current="true"') : ""}>${STATUS_LABEL[k]} <span class="n">${count(k)}</span></a>`,
    )}</div>
<form method="get" action="/tokens" class="row">
${query.status !== "active" ? html`<input type="hidden" name="status" value="${query.status}">` : ""}${query.showSessions ? html`<input type="hidden" name="sessions" value="1">` : ""}
<label class="search"><span class="sr">Filter tokens</span>${ICON.search}<input class="field" type="search" name="q" maxlength="100" placeholder="Name or scope, e.g. atlas-api" value="${q}"></label>
<button class="btn" type="submit">Search</button>
</form>
</div>
<div class="card clip">
<div class="scroll"><table class="tbl">
<thead><tr><th>Token</th><th>Access</th><th>Last used</th><th>Expires</th><th><span class="sr">Actions</span></th></tr></thead>
<tbody>
${rows.map(
      (t) => html`<tr class="${t.revoked_at ? "is-revoked" : ""}">
<td><div class="stack g4"><div class="row"><span class="nm"><strong>${t.name}</strong></span>${t.kind === "session" ? html`<span class="badge">session</span>` : ""}${
        isWholeVault(t.scopes) && !t.revoked_at
          ? html`<span class="badge warn" title="Wildcard on every space: this token reaches the whole vault, including spaces created later.">${ICON.warn}Whole vault</span>`
          : ""
      }</div><span class="mono muted small" title="${t.id}">${t.id}</span></div></td>
<td><div class="chips">${t.scopes.map((s) => scopeChip(s))}</div></td>
<td><span title="${t.last_used_at ?? ""}">${t.last_used_at ? relTime(t.last_used_at) : "Never used"}</span></td>
<td>${t.expires_at ? html`<div class="stack g4"><span title="${t.expires_at}">${shortDate(t.expires_at)}</span><span class="hint small">${relTime(t.expires_at)}</span></div>` : "Never"}</td>
<td>${
        t.revoked_at
          ? html`<span class="badge" title="Revoked ${t.revoked_at}">Revoked ${shortDate(t.revoked_at)}</span>`
          : html`<div class="row">${t.expired ? html`<span class="badge err">Expired</span>` : ""}<form method="post" action="/tokens/${t.id}/revoke" class="inline" data-confirm="Revoke this token? Clients using it will stop working.">${csrfField(ctx)}<button class="btn btn-danger btn-sm" type="submit">Revoke</button></form></div>`
      }</td>
</tr>`,
    )}
</tbody></table>
${
      rows.length === 0
        ? html`<div class="empty"><strong>${q ? html`No token matches "${q}"` : html`No ${query.status === "all" ? "" : STATUS_LABEL[query.status].toLowerCase() + " "}tokens`}</strong><span>${q ? "Search looks at token names, ids and scopes." : query.status === "expired" ? "Tokens show up here once their expiry date passes. They stop working automatically." : "Nothing to show for this filter."}</span></div>`
        : ""
    }
</div>
${hiddenRevoked ? html`<div class="foot"><span>${hiddenRevoked} revoked token${hiddenRevoked === 1 ? "" : "s"} hidden.</span><a href="${tokensUrl({ status: "revoked", sessions: query.showSessions })}">Show revoked</a></div>` : ""}
</div>
<p class="hint">${
      query.showSessions
        ? html`Showing session grants too. <a href="${tokensUrl({ status: query.status, q, sessions: false })}">Hide them</a>`
        : html`Session grants (from token-less sessions) are hidden: they live on the <a href="/access">Access</a> page. <a href="${tokensUrl({ status: query.status, q, sessions: true })}">Show them</a>`
    }</p>`,
  );
}

// ---- new token -------------------------------------------------------------

export interface TokenForm {
  name: string;
  scopes: string;
  preset: string;
  allowWildcard: boolean;
  expiresInDays: string;
  project: string;
  dir: string;
}

export const EMPTY_TOKEN_FORM: TokenForm = { name: "", scopes: "", preset: "", allowWildcard: false, expiresInDays: "90", project: "", dir: "" };

const TEMPLATES: Array<[string, string, string]> = [
  ["project", "Project", "Read the shared meta space, read & write one project. For a Claude Code instance."],
  ["agent", "Agent", "Read & write its own agents/<name> space. Extra scopes can be added."],
  ["master-ro", "Read-only everywhere", "Read the whole vault. Wildcard: needs confirmation."],
  ["master", "Full access", "Read & write the whole vault. Wildcard: needs confirmation."],
  ["", "Custom", "No preset: build every scope yourself."],
];
const EXPIRIES: Array<[string, string]> = [["7", "7 days"], ["30", "30 days"], ["90", "90 days · recommended"], ["365", "1 year"], ["", "Never"]];

// Embedded as JSON in a non-executed <script> block: "<" is escaped so "</script>" cannot appear.
const jsonData = (v: unknown): SafeHtml => raw(JSON.stringify(v).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026"));

export function newTokenView(ctx: Ctx, form: TokenForm = EMPTY_TOKEN_FORM, projects: string[] = [], banner?: Banner): SafeHtml {
  const f = form;
  const expiries = EXPIRIES.some(([v]) => v === f.expiresInDays) ? EXPIRIES : [...EXPIRIES.slice(0, -1), [f.expiresInDays, `${f.expiresInDays} days`] as [string, string], EXPIRIES[EXPIRIES.length - 1]];
  return layout(
    ctx,
    "/tokens",
    "New token",
    html`<div class="stack"><a class="back" href="/tokens">${ICON.back}Tokens</a>${pageHead("New token", "Grant the smallest access the client needs. You'll see the token once, right after creating it.")}</div>
${bannerView(banner)}
<form method="post" action="/tokens" id="tokform" class="ntf">
${csrfField(ctx)}
<div class="ntf-main">
<section class="card pad stack">
<label for="name" class="lbl">Name</label>
<input class="field w420" type="text" id="name" name="name" maxlength="64" required placeholder="e.g. claude-laptop" value="${f.name}">
<span class="hint">1-64 characters. Shows up in the audit log and in commit messages. Name it after the client or machine.</span>
</section>
<section class="card pad stack g16">
<div class="stack g4"><h2>Access</h2><span class="hint">Start from a template, then adjust. A preset is used instead of listing scopes (except Project and Agent, where scopes are added on top).</span></div>
<fieldset class="tpl-grid"><legend class="sr">Access template</legend>${TEMPLATES.map(
      ([v, title, text]) => html`<label class="tpl"><input type="radio" name="preset" value="${v}"${f.preset === v ? raw(" checked") : ""}><span class="tpl-box"><b>${title}</b><span class="hint">${text}</span></span></label>`,
    )}</fieldset>
<div class="stack" id="project-field">
<label for="project" class="lbl">Project <span class="hint">(Project template only: <code>space/project</code>, pick an existing one or type a new one)</span></label>
<input class="field w420" type="text" id="project" name="project" list="projects" maxlength="129" autocomplete="off" spellcheck="false" placeholder="pro/second-brain" value="${f.project}">
<datalist id="projects">${projects.map((p) => html`<option value="${p}"></option>`)}</datalist>
</div>
<div class="stack">
<div class="row between"><span class="lbl js-only">Scopes</span><span class="hint js-only" id="scope-count"></span></div>
<div id="builder" class="js-only" hidden></div>
</div>
<details class="fold" open>
<summary>${ICON.help}How scopes work</summary>
<div class="body">
<div class="anat"><div><span class="part">pro</span><span class="hint small">space</span></div><span class="colon">:</span><div><span class="part">atlas-api</span><span class="hint small">project</span></div><span class="colon">:</span><div><span class="part">*</span><span class="hint small">section</span></div><span class="colon">:</span><div><span class="part p-write">write</span><span class="hint small">permission</span></div></div>
<div class="perm-grid">
<div class="stack g4"><span class="permtag p-read">read</span><span class="hint">Read, search, list notes and browse their history.</span></div>
<div class="stack g4"><span class="permtag p-write">write</span><span class="hint">Everything read allows, plus create, edit, append and archive notes. Each change is a commit.</span></div>
<div class="stack g4"><span class="permtag p-propose">propose</span><span class="hint">Send changes to your Inbox. Nothing is written until you accept.</span></div>
</div>
<ul class="hint"><li><code>*</code> means "all", and only at the end: <code>pro:*:*</code> works, <code>*:atlas-api:notes</code> does not.</li><li>Wildcards also match spaces and projects created later, so they need an explicit confirmation.</li></ul>
</div>
</details>
<details class="fold" id="lines-details" open>
<summary>${ICON.code}Scope lines <span class="hint">the same thing as text, one per line</span></summary>
<div class="body">
<label for="scopes" class="hint"><code>space:project:section:permission</code>, permission is read, write or propose; <code>*</code> only as trailing levels. Leave empty when using a preset without extra scopes.</label>
<textarea class="field" id="scopes" name="scopes" spellcheck="false" placeholder="pro:second-brain:*:write">${f.scopes}</textarea>
</div>
</details>
</section>
<section class="card pad stack">
<label for="dir" class="lbl">Local directory <span class="hint">(optional)</span></label>
<input class="field w560" type="text" id="dir" name="dir" maxlength="512" spellcheck="false" placeholder="~/Project/second-brain-mcp" value="${f.dir}">
<span class="hint">The generated Claude Code command starts with <code>cd &lt;dir&gt; &amp;&amp;</code>.</span>
</section>
<section class="card pad stack">
<fieldset class="chipset"><legend class="lbl">Expires</legend>${expiries.map(
      ([v, label]) => html`<label class="chip"><input type="radio" name="expires_in_days" value="${v}"${f.expiresInDays === v ? raw(" checked") : ""}><span>${label}</span></label>`,
    )}</fieldset>
<span class="hint" id="exp-hint">Optional, 1-3650 days. Never: the token stays valid until you revoke it.</span>
</section>
</div>
<aside class="card pad ntf-side" aria-label="Summary">
<div class="stack g16" id="sum"><h2>Summary</h2><span class="hint">Choose a template and the scopes appear here (needs JavaScript). The server checks everything on submit.</span></div>
<div class="stack" id="wild-box">
<label class="check"><input type="checkbox" id="allow-wildcard" name="allow_wildcard" value="1"${f.allowWildcard ? raw(" checked") : ""}><span>Allow wildcard: I understand a <code>*</code> scope or a master preset also covers spaces, projects or sections created later.</span></label>
</div>
<div class="stack">
<button class="btn btn-primary btn-block" type="submit" id="create-btn">Create token</button>
<span class="hint" id="wild-hint" hidden>Confirm the wildcard access above to continue.</span>
<a class="btn btn-ghost btn-block" href="/tokens">Cancel</a>
</div>
</aside>
<script type="application/json" id="sb-projects">${jsonData(projects)}</script>
</form>`,
  );
}

// ---- token created ---------------------------------------------------------

export function tokenCreatedView(
  ctx: Ctx,
  created: { id: string; name: string; token: string; expires_at?: string | null },
  notes: string[],
  command: string,
  scopes: Scope[] = [],
): SafeHtml {
  return layout(
    ctx,
    "/tokens",
    "Token created",
    html`<div class="stack g16">
<div class="row g12"><span class="okmark">${ICON.check}</span><div class="stack g4"><h1>${created.name} is ready</h1><span class="hint">Created just now · ${created.expires_at ? html`expires <span title="${created.expires_at}">${shortDate(created.expires_at)}</span>` : "never expires"} · <span class="mono">${created.id}</span></span></div></div>
${notes.length ? html`<div class="banner warn" role="status"><ul>${notes.map((n) => html`<li>${n}</li>`)}</ul></div>` : ""}
<section class="card pad stack g12 once">
<div class="row between"><label class="lbl" for="token-value">Your token</label><span class="badge warn">${ICON.eye}Shown only once</span></div>
<div class="row">
<input class="field secret" type="text" id="token-value" readonly spellcheck="false" value="${created.token}">
<button type="button" class="btn btn-dark" data-copy="token-value">${ICON.copy}Copy</button>
</div>
<span class="status" id="token-value-status" role="status"></span>
<p>Put it in your password manager or the client's config now. It is not stored in plaintext, so it can't be shown again. Reloading or leaving this page will not show it again. Lost it? Revoke it and create a new one.</p>
</section>
<section class="card pad stack g12">
<span class="lbl">Access granted</span>
${scopes.length === 0 ? html`<span class="muted">No scopes.</span>` : scopes.map((s) => html`<div class="grant">${scopeChip(s)}<span class="hint">${scopeDescription(s)}</span></div>`)}
</section>
<section class="card pad stack g12">
<h2 class="sm">Claude Code</h2>
<p>Run this in a terminal <strong>inside the project directory</strong> (it registers the server for that directory only). Never paste the token into a chat.</p>
<textarea class="field cmd" id="claude-cmd" readonly rows="4" spellcheck="false">${command}</textarea>
<div class="actions"><button type="button" class="btn btn-dark" data-copy="claude-cmd">${ICON.copy}Copy</button><span class="status" id="claude-cmd-status" role="status"></span></div>
</section>
<div class="row between g12">
<label class="check"><input type="checkbox" id="stored"><span>I've copied and stored this token</span></label>
<a class="btn btn-primary" id="done" href="/tokens">Done</a>
</div>
</div>`,
  );
}
