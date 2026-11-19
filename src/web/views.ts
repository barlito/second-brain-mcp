// Page renderers for the web admin UI. Every dynamic value goes through html`` (escaped).
import MarkdownIt from "markdown-it";
import type { InboxListItem, ShownProposal } from "../admin/service";
import type { PendingRequest } from "../access";
import type { AuditRow } from "../audit";
import type { ActiveSession } from "../auth/sessions";
import { CONNECTOR_HEADER, type ConnectorKeyEntry } from "../auth/connectorKeys";
import type { Scope, TokenListEntry } from "../auth/tokens";
import { formatScope } from "../cli/token";
import { APP_VERSION } from "../version";
import type { PushSubscriptionRow } from "../push";
import { html, raw, SafeHtml } from "./html";
import { THEME_COLOR } from "./pwa";

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
  // Sidebar badges: pending proposals / pending access requests (null: unknown, no badge).
  // accessRev: live-feed revision the page was rendered at (see /access/events).
  counts?: { inbox: number | null; access: number | null; accessRev?: number };
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


// ---- icons (inline SVG, stroke=currentColor, decorative) ---------------------

const svg = (size: number, body: string, sw = 1.75): SafeHtml =>
  raw(`<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`);

export const ICON = {
  brand: svg(16, '<path d="M12 3a5 5 0 0 0-5 5v1a4 4 0 0 0 0 8h1"/><path d="M12 3a5 5 0 0 1 5 5v1a4 4 0 0 1 0 8h-1"/><path d="M12 3v18"/>', 2),
  overview: svg(16, '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>'),
  inbox: svg(16, '<path d="M3 13h5l1.5 3h5l1.5-3h5"/><path d="M5.5 5h13l2.5 8v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-6z"/>'),
  access: svg(16, '<path d="M12 3 4 6v6c0 4.5 3.2 7.8 8 9 4.8-1.2 8-4.5 8-9V6z"/><path d="m9 12 2 2 4-4"/>'),
  vault: svg(16, '<path d="M3 6.5A2.5 2.5 0 0 1 5.5 4H9l2 2.5h7.5A2.5 2.5 0 0 1 21 9v8.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/>'),
  tokens: svg(16, '<circle cx="8" cy="15" r="4"/><path d="M10.8 12.2 20 3"/><path d="m16 7 3 3"/><path d="m14 9 2 2"/>'),
  audit: svg(16, '<path d="M3 12h4l3-8 4 16 3-8h4"/>'),
  plus: svg(16, '<path d="M12 5v14M5 12h14"/>', 2),
  search: svg(16, '<circle cx="11" cy="11" r="6"/><path d="m20 20-4.5-4.5"/>', 2),
  back: svg(14, '<path d="m15 18-6-6 6-6"/>', 2),
  next: svg(14, '<path d="m9 18 6-6-6-6"/>', 2),
  check: svg(20, '<path d="m5 12 5 5 9-10"/>', 2.25),
  checkSm: svg(16, '<path d="m5 12 5 5 9-10"/>', 2.25),
  warn: svg(12, '<path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17h.01"/>', 2.25),
  eye: svg(12, '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>', 2.25),
  copy: svg(16, '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/>', 2),
  help: svg(16, '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5v.2M12 17h.01"/>', 2),
  code: svg(16, '<path d="m8 7-5 5 5 5M16 7l5 5-5 5"/>', 2),
  folder: svg(18, '<path d="M3 6.5A2.5 2.5 0 0 1 5.5 4H9l2 2.5h7.5A2.5 2.5 0 0 1 21 9v8.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/>'),
  file: svg(16, '<path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>'),
  history: svg(16, '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>'),
  edit: svg(16, '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>'),
  archive: svg(16, '<rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v10h14V9M10 13h4"/>'),
  close: svg(12, '<path d="M6 6l12 12M18 6 6 18"/>', 2.5),
};

// ---- shared view helpers ---------------------------------------------------

export const fmtSize = (n: number): string => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KiB`);

// "2 min ago" / "in 3 days" relative to now; the full timestamp goes in a title attribute.
export function relTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "never";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const diff = now - t;
  const abs = Math.abs(diff);
  const m = Math.round(abs / 60_000);
  const unit = m < 1 ? "" : m < 60 ? `${m} min` : m < 2880 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} days`;
  if (!unit) return "just now";
  return diff >= 0 ? `${unit} ago` : `in ${unit}`;
}

export const shortDate = (iso: string): string => (/^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : iso);

export const PERM_LABEL: Record<string, string> = { read: "read", write: "read & write", propose: "propose" };

// Plain-language description of one scope. `write` includes `read`.
export function scopeDescription(s: Pick<Scope, "space" | "project" | "section" | "permission">): string {
  const verb = s.permission === "read" ? "Read" : s.permission === "write" ? "Read & write" : "Propose changes to";
  const where =
    s.space === "*" ? "every note in the vault" : s.project === "*" ? `every project in ${s.space}` : s.section === "*" ? `every section of ${s.space}/${s.project}` : `${s.space}/${s.project}/${s.section} only`;
  return `${verb} ${where}${[s.space, s.project, s.section].includes("*") ? ", including ones created later" : ""}.`;
}

// `path | permission` chip colored by permission; the title carries the plain-language meaning.
export const scopeChip = (s: Scope): SafeHtml =>
  html`<span class="scope" title="${scopeDescription(s)}"><span class="scope-path">${s.space}:${s.project}:${s.section}</span><span class="scope-perm p-${s.permission}">${PERM_LABEL[s.permission] ?? s.permission}</span></span>`;

// Risk of a requested scope list beyond the default shape (the shared meta read is the default, not a risk).
export function wildcardRisk(scopes: Scope[]): { whole: Scope[]; broad: Scope[] } {
  const risky = scopes.filter((s) => !(s.space === "meta" && s.project === "*" && s.section === "*" && s.permission === "read"));
  return { whole: risky.filter((s) => s.space === "*"), broad: risky.filter((s) => s.space !== "*" && s.project === "*") };
}
export const isWholeVault = (scopes: Scope[]): boolean => scopes.some((s) => s.space === "*" && s.project === "*" && s.section === "*");

export const csrfField = (ctx: Ctx): SafeHtml =>
  html`<input type="hidden" name="csrf" value="${ctx.csrf}"><input type="hidden" name="nonce" value="${ctx.nonce()}">`;

const countBadge = (n: number | null | undefined): SafeHtml | "" => (n ? html`<span class="count" aria-label="${n} pending">${n}</span>` : "");

// ---- layout ----------------------------------------------------------------

export function layout(ctx: Ctx, active: string, title: string, body: SafeHtml): SafeHtml {
  const nav: Array<[string, string, SafeHtml, SafeHtml | ""]> = [
    ["/", "Overview", ICON.overview, ""],
    ["/inbox", "Inbox", ICON.inbox, countBadge(ctx.counts?.inbox)],
    ["/access", "Access", ICON.access, countBadge(ctx.counts?.access)],
    ["/vault", "Vault", ICON.vault, ""],
    ["/tokens", "Tokens", ICON.tokens, ""],
    ["/audit", "Audit log", ICON.audit, ""],
  ];
  const initials = ctx.user.replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(" ").map((w) => w[0]).slice(0, 2).join("") || "?";
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="theme-color" content="${THEME_COLOR}">
<link rel="manifest" href="/manifest.webmanifest" crossorigin="use-credentials">
<link rel="icon" type="image/png" sizes="192x192" href="/static/icon-192.png">
<link rel="apple-touch-icon" href="/static/icon-192.png">
<title>${title} - second-brain admin</title>
<link rel="stylesheet" href="/static/style.css">
<script src="/static/theme.js"></script>
<script src="/static/app.js" defer></script>
</head>
<body data-access-rev="${ctx.counts?.accessRev ?? ""}">
<div class="app">
<div class="side">
<a class="brand" href="/"><span class="brand-mark">${ICON.brand}</span><span class="brand-name"><b>second-brain</b><span>admin</span></span></a>
<nav class="nav" aria-label="Main">${nav.map(
    ([href, label, icon, badge]) => html`<a href="${href}"${href === active ? raw(' aria-current="page"') : ""}>${icon}<span class="label">${label}</span>${badge}</a>`,
  )}</nav>
<div class="side-foot">
<div class="theme" data-theme-toggle role="group" aria-label="Theme" hidden>
<button type="button" data-theme-set="auto" aria-pressed="true">Auto</button>
<button type="button" data-theme-set="light" aria-pressed="false">Light</button>
<button type="button" data-theme-set="dark" aria-pressed="false">Dark</button>
</div>
<span class="version" title="Running version">${APP_VERSION}</span>
<div class="who"><span class="avatar" aria-hidden="true">${initials}</span><span class="who-text"><b>${ctx.user}</b><span>Signed in</span></span></div>
</div>
</div>
<main class="main">
<div class="wrap">
${body}
</div>
</main>
</div>
</body>
</html>`;
}

// Page title block: optional back link, h1, lead text and an action area.
export const pageHead = (title: string, lead?: SafeHtml | string, actions?: SafeHtml | ""): SafeHtml =>
  html`<div class="head"><div class="head-text"><h1>${title}</h1>${lead ? html`<p class="lead">${lead}</p>` : ""}</div>${actions ?? ""}</div>`;

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
  wholeVaultTokens: number | null;
  pendingProposals: number | null;
  pendingAccess: number | null;
  audit24h: number | null;
  denied24h: number | null;
  errors24h: number | null;
  recent: AuditRow[];
}

const health = (ok: boolean, yes = "Healthy", no = "Error"): SafeHtml => html`<span class="badge ${ok ? "ok" : "err"}"><span class="dot"></span>${ok ? yes : no}</span>`;
const resultBadge = (r: string): SafeHtml => html`<span class="badge ${r === "ok" ? "ok" : r === "denied" ? "warn" : "err"}">${r === "ok" ? "OK" : r === "denied" ? "Denied" : "Error"}</span>`;
const auditTarget = (r: AuditRow): string => [r.space, r.project, r.section, r.note].filter(Boolean).join("/");

export function dashboardView(ctx: Ctx, d: DashboardData): SafeHtml {
  const push = d.lastPushOk === null ? html`<span class="badge">No push yet</span>` : d.lastPushOk ? html`<span class="badge ok">OK</span>` : html`<span class="badge err">Failed</span>`;
  const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? "" : "s"}`;
  const attention = (d.pendingProposals ?? 0) + (d.pendingAccess ?? 0);
  return layout(
    ctx,
    "/",
    "Dashboard",
    html`${pageHead("Overview", attention > 0 ? "Everything is running. Something needs you." : "Everything is running. Nothing is waiting for you.")}
${
      d.pendingProposals
        ? html`<div class="callout"><span class="ico">${ICON.inbox}</span><div class="body"><strong>${plural(d.pendingProposals, "proposal")} waiting for review</strong><span class="hint">Changes proposed by tokens with propose access. Nothing is written until you accept.</span></div><a class="btn btn-primary" href="/inbox">Review inbox</a></div>`
        : ""
    }
${
      d.pendingAccess
        ? html`<div class="callout"><span class="ico">${ICON.access}</span><div class="body"><strong>${plural(d.pendingAccess, "access request")} waiting for approval</strong><span class="hint">Clients connected without a token are asking for access. Nothing is granted until you approve.</span></div><a class="btn btn-primary" href="/access">Review requests</a></div>`
        : ""
    }
<div class="stats">
<a class="card stat" href="/tokens"><span class="hint">Active tokens</span><span class="n">${d.activeTokens ?? "n/a"}</span>${d.wholeVaultTokens ? html`<span class="badge warn nowrap">${d.wholeVaultTokens} with whole-vault access</span>` : ""}</a>
<a class="card stat" href="/inbox"><span class="hint">Pending proposals</span><span class="n">${d.pendingProposals ?? "n/a"}</span></a>
<a class="card stat" href="/access"><span class="hint">Pending access requests</span><span class="n">${d.pendingAccess ?? "n/a"}</span></a>
<a class="card stat" href="/audit"><span class="hint">Audit events, last 24 h</span><span class="n">${d.audit24h ?? "n/a"}</span>${
      d.denied24h || d.errors24h
        ? html`<span class="row">${d.denied24h ? html`<span class="badge warn">${d.denied24h} denied</span>` : ""}${d.errors24h ? html`<span class="badge err">${d.errors24h} errors</span>` : ""}</span>`
        : ""
    }</a>
</div>
<div class="cols">
<section class="card pad-sm c1"><h2 class="sm">System</h2>
<div class="kv"><span>Database</span>${health(d.dbOk)}</div>
<div class="kv"><span>Vault</span>${health(d.vaultOk)}</div>
<div class="kv"><span>Branch</span><code>${d.branch ?? "unknown"}</code></div>
<div class="kv"><span>Unpushed commits</span>${d.unpushed ? html`<span class="badge warn">Yes</span>` : html`<span class="badge ok">None</span>`}</div>
<div class="kv"><span>Last push</span><span class="row">${push}${d.lastPushAt ? html`<span class="muted small" title="${d.lastPushAt}">${relTime(d.lastPushAt)}</span>` : ""}</span></div>
<div class="kv"><span>Conflict branches</span>${d.conflictBranches.length === 0 ? html`<span class="badge ok">None</span>` : html`<span class="badge err">${d.conflictBranches.length}</span>`}</div>
<div class="kv"><span>Git remote</span>${d.hasRemote ? html`<span class="badge ok">Configured</span>` : html`<span class="badge">Local only</span>`}</div>
${d.lastError ? html`<div class="kv"><span>Last sync error</span><span class="muted">${d.lastError}</span></div>` : ""}
${
      d.conflictBranches.length === 0
        ? ""
        : html`<p class="hint">Acknowledged commits were moved aside; resolve them in the vault repo.</p><ul>${d.conflictBranches.map((b) => html`<li><code>${b}</code></li>`)}</ul>`
    }
</section>
<section class="card pad-sm c2">
<div class="row between"><h2 class="sm">Recent activity</h2><a class="small" href="/audit">Open audit log</a></div>
${
      d.recent.length === 0
        ? html`<p class="muted">No activity yet.</p>`
        : d.recent.map(
            (r) => html`<div class="ev"><span class="mono muted small" title="${r.ts}">${r.ts.slice(11, 19)}</span><span class="what">${r.token_name ? html`<strong>${r.token_name}</strong>` : html`<span class="muted">unknown token</span>`}<span class="act">${r.action}</span>${auditTarget(r) ? html`<span class="mono muted small tgt" title="${auditTarget(r)}">${auditTarget(r)}</span>` : ""}</span>${resultBadge(r.result)}</div>`,
          )
    }
</section>
</div>`,
  );
}

// ---- inbox -----------------------------------------------------------------

type InboxList = { proposals: InboxListItem[]; truncated: boolean };

function proposalList(list: InboxList, currentId?: string): SafeHtml {
  return html`<nav aria-label="Pending proposals" class="card clip list"><div class="list-head">${list.proposals.length} pending</div>${
    list.proposals.length === 0
      ? html`<div class="empty"><span>No pending proposals.</span></div>`
      : list.proposals.map(
          (p) => html`<a class="item" href="/inbox/${p.id}"${p.id === currentId ? raw(' aria-current="page"') : ""}><b>${p.target ? p.target.split("/").slice(-1)[0] : "Malformed proposal"}</b><span class="mono muted small">${p.target ?? "malformed"}</span>${p.reason ? html`<span class="hint">${p.reason}</span>` : ""}<span class="meta"><span>${p.proposed_by ?? "unknown"}</span><span>${relTime(p.created)}</span><span>${fmtSize(p.size)}</span></span></a>`,
        )
  }</nav>`;
}

export function inboxView(ctx: Ctx, list: InboxList, banner?: Banner): SafeHtml {
  return layout(
    ctx,
    "/inbox",
    "Inbox",
    html`${pageHead("Inbox", html`Changes proposed by tokens with <code>propose</code> access. Nothing is written until you accept.`)}
${bannerView(banner)}
${list.truncated ? html`<div class="banner warn">Only the first proposals are listed; resolve some to see the rest.</div>` : ""}
<div class="split">${proposalList(list)}<div class="detail"><div class="card empty">${ICON.inbox}<strong>${list.proposals.length ? "Select a proposal" : "All caught up"}</strong><span>${list.proposals.length ? "Pick one on the left to review its content, then accept or reject it." : "Proposals from agents show up here."}</span></div></div></div>`,
  );
}

export function proposalView(ctx: Ctx, p: ShownProposal, mode: "rendered" | "raw", banner?: Banner, list?: InboxList): SafeHtml {
  const detail = html`<article class="card clip">
<header class="dhead">
<span class="mono muted small">${p.target}</span>
<div class="row g12 hint"><span class="badge prop">${p.proposed_by}</span><span title="${p.created}">${relTime(p.created)}</span><span>${fmtSize(p.size)}</span><span class="mono small" title="Proposal ID">${p.id}</span></div>
<blockquote class="quote"><span class="hint">Reason</span>${p.reason}</blockquote>
<form method="post" action="/inbox/${p.id}/accept" class="stack" data-confirm="Accept this proposal and commit it to the vault?">
${csrfField(ctx)}
<label class="check"><input type="checkbox" name="overwrite" value="1"> Overwrite the existing target note if there is one</label>
<div class="actions"><button class="btn btn-primary" type="submit">${ICON.checkSm}Accept &amp; commit</button></div>
</form>
<form method="post" action="/inbox/${p.id}/reject" class="actions" data-confirm="Reject and delete this proposal?">
${csrfField(ctx)}
<button class="btn btn-danger" type="submit">Reject</button>
</form>
</header>
<div class="dbody stack g16">
<div class="seg" role="group" aria-label="View">
<a href="/inbox/${p.id}"${mode === "rendered" ? raw(' aria-current="page"') : ""}>Rendered</a>
<a href="/inbox/${p.id}?view=raw"${mode === "raw" ? raw(' aria-current="page"') : ""}>Markdown</a>
</div>
${mode === "raw" ? html`<pre>${p.content}</pre>` : html`<div class="md">${raw(md.render(p.content))}</div>`}
</div>
</article>`;
  return layout(
    ctx,
    "/inbox",
    "Proposal",
    html`<div class="stack"><a class="back" href="/inbox">${ICON.back}Inbox</a><h1>${p.target.split("/").slice(-1)[0]}</h1></div>
${bannerView(banner)}
<div class="split">${list ? proposalList(list, p.id) : ""}<div class="detail">${detail}</div></div>`,
  );
}

// ---- access requests (token-less sessions) --------------------------------

type ConnectorKey = ConnectorKeyEntry;

export interface PushPanel {
  publicKey: string;
  devices: PushSubscriptionRow[];
}

export function accessView(ctx: Ctx, pending: PendingRequest[], sessions: ActiveSession[], keys: ConnectorKey[], push: PushPanel, banner?: Banner): SafeHtml {
  return layout(
    ctx,
    "/access",
    "Access requests",
    html`${pageHead("Access", "Clients connected without a token ask for access to a project. Check the client and the reason, adjust the scopes if needed, then approve. Nothing is granted until you do.")}
${bannerView(banner)}
<h2>Pending requests</h2>
${
      pending.length === 0
        ? html`<div class="card empty"><strong>No pending requests</strong></div>`
        : pending.map(
            (r) => html`<div class="card pad stack g12">
<div class="row g12 anchor" id="req-${r.id}">${r.elevation ? html`<span class="badge err">elevation</span>` : ""}${r.agent ? html`<strong class="mono">${r.agent}</strong><span class="muted">${r.client_name} ${r.client_version}</span>` : html`<strong>${r.client_name}</strong><span class="muted">${r.client_version}</span>`}<span class="muted small">${relTime(r.created_at)}, expires ${r.expires_at}</span><span class="muted mono small">${r.id}</span></div>
<div class="stack"><span class="hint">Asks for</span>${r.requested_scopes.map((sc) => html`<div class="grant">${scopeChip(sc)}<span class="hint">${scopeDescription(sc)}</span></div>`)}</div>
${(() => {
              const k = wildcardRisk(r.requested_scopes);
              return html`${k.whole.length ? html`<div class="row"><span class="badge err" title="Wildcard on every space: reaches the whole vault, including spaces created later.">${ICON.warn}Whole vault</span><span class="hint">${k.whole.map(formatScope).join(", ")}</span></div>` : ""}${k.broad.length ? html`<div class="row"><span class="badge warn" title="Wildcard on every project of a space, including projects created later.">${ICON.warn}Broad</span><span class="hint">${k.broad.map(formatScope).join(", ")}</span></div>` : ""}`;
            })()}
${r.exceeds ? html`<div class="banner err" role="alert"><strong>scopes exceed the stated request</strong> (${r.access} on ${r.space}/${r.project}): review every scope above.</div>` : ""}
<p>Client: <strong>${r.client_name}</strong> ${r.client_version} &nbsp; Key: <strong>${r.connector_key ?? "?"}</strong> &nbsp; IP: <span class="mono">${r.remote_ip ?? "?"}</span></p>
<p>Reason: ${r.reason}</p>
<div class="stack"><span class="hint">Current grants of this session</span>${
              r.current_grants.length === 0
                ? html`<span class="muted">none</span>`
                : r.current_grants.map((g) => html`<div class="row"><strong>${g.name}</strong>${g.scopes.map((sc) => scopeChip(sc))}</div>`)
            }</div>
<form method="post" action="/access/${r.id}/approve" class="stack g12">
${csrfField(ctx)}
<div class="stack"><label class="lbl" for="scopes-${r.id}">Scopes <span class="hint">(one per line; leave as is to grant the default; write includes read)</span></label>
<textarea class="field" id="scopes-${r.id}" name="scopes" spellcheck="false" rows="4">${r.requested_scopes.map(formatScope).join("\n")}</textarea></div>
<div class="actions"><button class="btn btn-primary" type="submit">Approve</button></div>
</form>
<form method="post" action="/access/${r.id}/deny" class="actions" data-confirm="Deny this request?">
${csrfField(ctx)}
<button class="btn btn-danger" type="submit">Deny</button>
</form>
</div>`,
          )
    }
<h2>Active sessions</h2>
<div class="card clip"><div class="scroll"><table class="tbl">
<thead><tr><th>Agent / client</th><th>Key</th><th>Grants</th><th>IP</th><th>Created</th><th>Last seen</th><th>Expires</th><th></th></tr></thead>
<tbody>
${
      sessions.length === 0
        ? html`<tr><td colspan="8"><div class="empty">No sessions with access.</div></td></tr>`
        : sessions.map(
            (s) => html`<tr>
<td>${s.agent ? html`<strong class="mono">${s.agent}</strong><br><span class="muted small">${s.client_name} ${s.client_version}</span>` : html`${s.client_name} ${s.client_version}`}<br><span class="muted mono small">${s.id}</span></td>
<td>${s.connector_key ?? ""}</td>
<td>${s.grants.map((g) => html`<div class="stack g4"><strong>${g.name}</strong><div class="chips">${g.scopes.map((sc) => scopeChip(sc))}</div></div>`)}</td>
<td class="mono small">${s.remote_ip ?? ""}</td>
<td class="mono small">${s.created_at}</td>
<td class="mono small">${s.last_seen_at}</td>
<td class="mono small">${s.expires_at}</td>
<td><form method="post" action="/access/sessions/${s.id}/revoke" class="inline" data-confirm="Revoke this session? Its access stops immediately.">${csrfField(ctx)}<button class="btn btn-danger btn-sm" type="submit">Revoke</button></form></td>
</tr>`,
          )
    }
</tbody></table></div></div>
<h2>Connector keys</h2>
<p class="muted">Token-less access is closed unless a client sends a valid key in the <code>${CONNECTOR_HEADER}</code> header (claude.ai connector "Request headers", or <code>--header</code> in Claude Code). Revoking a key ends the sessions opened through it and their grants.</p>
<div class="card clip"><div class="scroll"><table class="tbl">
<thead><tr><th>Name</th><th>Created</th><th>Last used</th><th>Status</th><th></th></tr></thead>
<tbody>
${
      keys.length === 0
        ? html`<tr><td colspan="5"><div class="empty">No keys: token-less access is disabled.</div></td></tr>`
        : keys.map(
            (k) => html`<tr>
<td>${k.name}<br><span class="muted mono small">${k.id}</span></td>
<td class="mono small">${k.created_at}</td>
<td class="mono small" title="${k.last_used_at ?? ""}">${k.last_used_at ? relTime(k.last_used_at) : "never"}</td>
<td>${k.revoked_at ? html`<span class="badge err">revoked</span>` : html`<span class="badge ok">active</span>`}</td>
<td>${k.revoked_at ? "" : html`<div class="row"><form method="post" action="/access/keys/${k.id}/reveal" class="inline">${csrfField(ctx)}<button class="btn btn-sm" type="submit">Reveal</button></form> <form method="post" action="/access/keys/${k.id}/revoke" class="inline" data-confirm="Revoke this key? Sessions opened through it end now.">${csrfField(ctx)}<button class="btn btn-danger btn-sm" type="submit">Revoke</button></form></div>`}</td>
</tr>`,
          )
    }
</tbody></table></div></div>
<form method="post" action="/access/keys" class="card pad stack g12">
${csrfField(ctx)}
<div class="stack"><label class="lbl" for="key-name">New key name <span class="hint">(1-64 characters, e.g. claude-ai)</span></label>
<input class="field w420" type="text" id="key-name" name="name" maxlength="64" required></div>
<div class="actions"><button class="btn btn-primary" type="submit">Create key</button></div>
</form>
<h2>Notifications</h2>
<div class="card pad stack g12" id="push" data-vapid-key="${push.publicKey}">
<p class="muted">Get a notification on this device when an agent asks for access, tap it to open the request. Payloads are encrypted end to end and carry no secret.</p>
<p class="hint" id="push-hint" role="status" hidden></p>
${
      push.devices.length === 0
        ? html`<p class="muted">No device registered.</p>`
        : html`<div class="card clip">${push.devices.map(
            (d) => html`<div class="dev"><div class="stack g4"><strong>${d.label}</strong><span class="hint">Added <span title="${d.created_at}">${relTime(d.created_at)}</span>, last delivered <span title="${d.last_ok_at ?? ""}">${d.last_ok_at ? relTime(d.last_ok_at) : "never"}</span></span></div><form method="post" action="/push/${d.id}/remove" class="inline" data-confirm="Stop notifications on this device?">${csrfField(ctx)}<button class="btn btn-danger btn-sm" type="submit">Remove</button></form></div>`,
          )}</div>`
    }
<form method="post" action="/push/subscribe" id="push-form" class="stack g12" hidden>
${csrfField(ctx)}
<input type="hidden" name="endpoint" value=""><input type="hidden" name="p256dh" value=""><input type="hidden" name="auth" value="">
<div class="stack"><label class="lbl" for="push-label">Device name <span class="hint">(1-64 characters)</span></label>
<input class="field w420" type="text" id="push-label" name="label" maxlength="64" required></div>
<div class="actions"><button class="btn btn-primary" type="submit" id="push-enable">Enable on this device</button></div>
</form>
${push.devices.length === 0 ? "" : html`<form method="post" action="/push/test" class="actions">${csrfField(ctx)}<button class="btn" type="submit">Send a test notification</button></form>`}
</div>`,
  );
}

export function connectorKeyCreatedView(ctx: Ctx, created: { id: string; name: string; key: string }, command: string, revealed = false): SafeHtml {
  return layout(
    ctx,
    "/access",
    revealed ? "Connector key" : "Connector key created",
    html`<div class="stack"><a class="back" href="/access">${ICON.back}Access</a>${pageHead(revealed ? "Connector key" : "Connector key created")}</div>
<div class="banner warn" role="alert"><strong>This is a secret.</strong> Paste it into the connector and do not share it. You can reveal it again from the Access page (audited).</div>
<div class="card pad stack g12">
<p>Name: <strong>${created.name}</strong> <span class="muted mono small">(${created.id})</span></p>
<h2 class="sm">claude.ai</h2>
<p>Custom connector: Authentication "No connection", then add a request header (mark it required):</p>
<p>Header name: <code>${CONNECTOR_HEADER}</code></p>
<textarea class="field cmd" id="ckey-value" readonly rows="2" spellcheck="false">${created.key}</textarea>
<div class="actions"><button type="button" class="btn btn-dark" data-copy="ckey-value">${ICON.copy}Copy value</button><span class="status" id="ckey-value-status" role="status"></span></div>
</div>
<div class="card pad stack g12">
<h2 class="sm">Claude Code</h2>
<textarea class="field cmd" id="claude-cmd" readonly rows="3" spellcheck="false">${command}</textarea>
<div class="actions"><button type="button" class="btn btn-dark" data-copy="claude-cmd">${ICON.copy}Copy</button><span class="status" id="claude-cmd-status" role="status"></span></div>
</div>`,
  );
}

export function errorView(ctx: Ctx, status: number, message: string): SafeHtml {
  return layout(ctx, "", `Error ${status}`, html`<h1>Error ${status}</h1><div class="banner err" role="alert">${message}</div><p><a href="/">Overview</a></p>`);
}
