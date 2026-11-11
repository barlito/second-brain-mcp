// Read-only audit log page. Filters are a plain GET form (no state change, no CSRF).
import type { AuditRow } from "../audit";
import { html, SafeHtml } from "./html";
import { Ctx, layout } from "./views";

export interface AuditFilters {
  token?: string;
  action?: string;
}

export function auditView(ctx: Ctx, rows: AuditRow[], nextBefore: number | null, f: AuditFilters): SafeHtml {
  const q = new URLSearchParams();
  if (f.token !== undefined) q.set("token", f.token);
  if (f.action !== undefined) q.set("action", f.action);
  const next = nextBefore === null ? null : `/audit?${new URLSearchParams([...q, ["before", String(nextBefore)]]).toString()}`;
  return layout(
    ctx,
    "/audit",
    "Audit",
    html`<h1>Audit log</h1>
<form method="get" action="/audit" class="card stack">
<label for="token">Token name <span class="hint">(exact match)</span></label>
<input type="text" id="token" name="token" maxlength="256" value="${f.token ?? ""}">
<label for="action">Action <span class="hint">(exact match, e.g. kb_write)</span></label>
<input type="text" id="action" name="action" maxlength="64" value="${f.action ?? ""}">
<div class="actions"><button class="primary" type="submit">Filter</button><a href="/audit">Reset</a></div>
</form>
<div class="scroll"><table>
<thead><tr><th>Id</th><th>Time</th><th>Token</th><th>Action</th><th>Target</th><th>Result</th><th>Detail</th><th>Commit</th></tr></thead>
<tbody>${
      rows.length === 0
        ? html`<tr><td colspan="8" class="muted">No entries.</td></tr>`
        : rows.map(
            (r) => html`<tr>
<td class="mono">${r.id}</td><td class="mono">${r.ts}</td><td>${r.token_name ?? ""}</td><td><code>${r.action}</code></td>
<td class="mono">${[r.space, r.project, r.section, r.note].filter(Boolean).join("/")}</td>
<td><span class="badge ${r.result === "ok" ? "ok" : r.result === "denied" ? "warn" : "err"}">${r.result}</span></td>
<td>${r.detail ?? ""}</td><td class="mono">${r.git_commit ?? ""}</td>
</tr>`,
          )
    }</tbody></table></div>
${next ? html`<p><a href="${next}">Older entries</a></p>` : ""}`,
  );
}
