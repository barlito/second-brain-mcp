// Read-only audit log page. Filters are a plain GET form (no state change, no CSRF).
import type { AuditRow } from "../audit";
import { html, SafeHtml } from "./html";
import { Ctx, ICON, layout, pageHead } from "./views";

export interface AuditFilters {
  token?: string;
  action?: string;
}

export function auditView(ctx: Ctx, rows: AuditRow[], nextBefore: number | null, f: AuditFilters): SafeHtml {
  const q = new URLSearchParams();
  if (f.token !== undefined) q.set("token", f.token);
  if (f.action !== undefined) q.set("action", f.action);
  const next = nextBefore === null ? null : `/audit?${new URLSearchParams([...q, ["before", String(nextBefore)]]).toString()}`;
  // One filter removed: same query minus that key.
  const without = (key: "token" | "action"): string => {
    const p = new URLSearchParams(q);
    p.delete(key);
    const s = p.toString();
    return `/audit${s ? `?${s}` : ""}`;
  };
  const filtered = f.token !== undefined || f.action !== undefined;
  return layout(
    ctx,
    "/audit",
    "Audit",
    html`${pageHead("Audit log", "Every call made with a token or from this admin, newest first. Read-only.")}
<form method="get" action="/audit" class="filters">
<label class="sr" for="token">Token name (exact match)</label>
<input class="field" type="text" id="token" name="token" maxlength="256" placeholder="Token name (exact)" value="${f.token ?? ""}">
<label class="sr" for="action">Action (exact match)</label>
<input class="field" type="text" id="action" name="action" maxlength="64" placeholder="Action, e.g. kb_write" value="${f.action ?? ""}">
<button class="btn btn-primary" type="submit">Filter</button>
${filtered ? html`<a class="btn btn-ghost" href="/audit">Reset</a>` : ""}
</form>
${
      filtered
        ? html`<div class="row"><span class="hint">Filtered by</span>${f.token !== undefined ? html`<span class="fchip">token: ${f.token}<a href="${without("token")}" aria-label="Remove token filter">${ICON.close}</a></span>` : ""}${f.action !== undefined ? html`<span class="fchip">action: ${f.action}<a href="${without("action")}" aria-label="Remove action filter">${ICON.close}</a></span>` : ""}</div>`
        : ""
    }
<div class="card clip">
<div class="scroll"><table class="tbl compact">
<thead><tr><th>Time</th><th>Token</th><th>Action</th><th>Target</th><th>Result</th><th>Detail</th><th>Commit</th></tr></thead>
<tbody>${
      rows.length === 0
        ? html`<tr><td colspan="7"><div class="empty"><strong>No entries</strong></div></td></tr>`
        : rows.map(
            (r) => html`<tr data-id="${r.id}">
<td class="mono small nowrap" title="${r.ts}">${r.ts.slice(0, 19).replace("T", " ")}</td>
<td>${r.token_name ? html`<span class="trunc" title="${r.token_name}">${r.token_name}</span>` : html`<span class="muted">unknown token</span>`}</td>
<td><span class="act">${r.action}</span></td>
<td class="mono small"><span class="trunc" title="${[r.space, r.project, r.section, r.note].filter(Boolean).join("/")}">${[r.space, r.project, r.section, r.note].filter(Boolean).join("/")}</span></td>
<td><span class="badge ${r.result === "ok" ? "ok" : r.result === "denied" ? "warn" : "err"}">${r.result}</span></td>
<td><span class="trunc" title="${r.detail ?? ""}">${r.detail ?? ""}</span></td><td class="mono small">${r.git_commit ?? ""}</td>
</tr>`,
          )
    }</tbody></table></div>
${next ? html`<div class="foot"><span></span><a class="btn btn-sm" href="${next}">Older entries ${ICON.next}</a></div>` : ""}
</div>`,
  );
}
