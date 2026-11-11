// Vault browser pages. Paths are built only from validated slugs; everything is escaped.
import type { Listing, NoteRef, ShownNote } from "../admin/vault";
import type { NoteHistoryEntry } from "../vault/git";
import { html, raw, SafeHtml } from "./html";
import { Banner, bannerView, csrfField, Ctx, fmtSize, layout, renderMd } from "./views";

const TITLE = "Vault";
const notePath = (t: NoteRef): string => `/vault/${t.space}/${t.project}/${t.section}/${t.note}`;

// parts: [] .. [space, project, section, note]; the last one is the current page.
function crumbs(parts: string[]): SafeHtml {
  const items = [html`<a href="/vault">vault</a>`];
  parts.forEach((p, i) => {
    const last = i === parts.length - 1;
    items.push(last ? html`<strong>${p}</strong>` : html`<a href="/vault/${parts.slice(0, i + 1).join("/")}">${p}</a>`);
  });
  return html`<p class="crumbs">${items.map((c, i) => html`${i ? " / " : ""}${c}`)}</p>`;
}

const LEVELS = ["spaces", "projects", "sections"];

export function browseView(ctx: Ctx, parts: string[], l: Listing, banner?: Banner): SafeHtml {
  const base = parts.length ? `/vault/${parts.join("/")}/` : "/vault/";
  const body =
    l.kind === "dirs"
      ? l.names.length === 0
        ? html`<p class="muted">Nothing here.</p>`
        : html`<ul>${l.names.map((n) => html`<li><a href="${base}${n}">${n}</a></li>`)}</ul>`
      : html`<p><a href="${base}_new">New note</a></p>
<div class="scroll"><table>
<thead><tr><th>Note</th><th>Size</th><th>Modified</th></tr></thead>
<tbody>${
          l.notes.length === 0
            ? html`<tr><td colspan="3" class="muted">No notes.</td></tr>`
            : l.notes.map((n) => html`<tr><td><a href="${base}${n.name}">${n.name}</a></td><td>${fmtSize(n.size)}</td><td class="mono">${n.mtime.toISOString()}</td></tr>`)
        }</tbody></table></div>`;
  return layout(ctx, "/vault", TITLE, html`<h1>${parts.length >= 3 ? "Notes" : `Vault: ${LEVELS[parts.length]}`}</h1>${crumbs(parts)}${bannerView(banner)}${body}`);
}

export function noteView(ctx: Ctx, t: NoteRef, n: ShownNote, mode: "rendered" | "raw", banner?: Banner): SafeHtml {
  const p = notePath(t);
  return layout(
    ctx,
    "/vault",
    TITLE,
    html`<h1>${t.note}</h1>${crumbs([t.space, t.project, t.section, t.note])}${bannerView(banner)}
<div class="card"><p>${fmtSize(n.size)} &nbsp; ${
      n.last
        ? html`last commit <a href="${p}/at/${n.last.sha}"><code>${n.last.sha}</code></a> <span class="muted mono">${n.last.date}</span> ${n.last.subject}`
        : html`<span class="muted">no commits yet</span>`
    }</p>
<p><a href="${p}/history">History</a></p></div>
<div class="tabs">
<a href="${p}"${mode === "rendered" ? raw(' aria-current="page"') : ""}>Rendered</a>
<a href="${p}?view=raw"${mode === "raw" ? raw(' aria-current="page"') : ""}>Raw</a>
</div>
<div class="card">${mode === "raw" ? html`<pre>${n.content}</pre>` : html`<div class="md">${renderMd(n.content)}</div>`}</div>
${
      n.writable
        ? html`<div class="actions">
<a href="${p}/edit">Edit</a>
<form method="post" action="${p}/archive" class="inline" data-confirm="Archive this note? It moves to the archive section (history is kept).">${csrfField(ctx)}<button class="danger" type="submit">Archive</button></form>
</div>`
        : html`<p class="muted">Archived notes are read-only.</p>`
    }`,
  );
}

const textarea = (content: string): SafeHtml =>
  // The HTML parser drops one leading newline in a textarea: add one back.
  html`<textarea id="content" name="content" class="wide" spellcheck="false">${raw("\n")}${content}</textarea>`;

export function editView(ctx: Ctx, t: NoteRef, content: string, base: string, banner?: Banner): SafeHtml {
  const p = notePath(t);
  return layout(
    ctx,
    "/vault",
    TITLE,
    html`<h1>Edit ${t.note}</h1>${crumbs([t.space, t.project, t.section, t.note])}${bannerView(banner)}
<form method="post" action="${p}/edit" class="card stack">
${csrfField(ctx)}<input type="hidden" name="base" value="${base}">
<label for="content">Content</label>
${textarea(content)}
<div class="actions"><button class="primary" type="submit">Save</button><a href="${p}">Cancel</a></div>
</form>`,
  );
}

export function newView(ctx: Ctx, t: Omit<NoteRef, "note">, name: string, content: string, banner?: Banner): SafeHtml {
  const dir = `/vault/${t.space}/${t.project}/${t.section}`;
  return layout(
    ctx,
    "/vault",
    TITLE,
    html`<h1>New note</h1>${crumbs([t.space, t.project, t.section])}${bannerView(banner)}
<form method="post" action="${dir}/_new" class="card stack">
${csrfField(ctx)}
<label for="note">Name <span class="hint">(slug: a-z, 0-9, hyphens; max 64; becomes <code>name.md</code>)</span></label>
<input type="text" id="note" name="note" maxlength="64" required value="${name}">
<label for="content">Content</label>
${textarea(content)}
<div class="actions"><button class="primary" type="submit">Create</button><a href="${dir}">Cancel</a></div>
</form>`,
  );
}

export function historyView(ctx: Ctx, t: NoteRef, entries: NoteHistoryEntry[]): SafeHtml {
  const p = notePath(t);
  return layout(
    ctx,
    "/vault",
    TITLE,
    html`<h1>History: ${t.note}</h1>${crumbs([t.space, t.project, t.section, t.note])}
<div class="scroll"><table>
<thead><tr><th>Commit</th><th>Date</th><th>Author</th><th>Subject</th></tr></thead>
<tbody>${
      entries.length === 0
        ? html`<tr><td colspan="4" class="muted">No commits yet.</td></tr>`
        : entries.map((e) => html`<tr><td><a href="${p}/at/${e.sha}"><code>${e.sha}</code></a></td><td class="mono">${e.date}</td><td>${e.author}</td><td>${e.subject}</td></tr>`)
    }</tbody></table></div>
<p><a href="${p}">Back to the note</a></p>`,
  );
}

export function atView(ctx: Ctx, t: NoteRef, hash: string, a: { content: string; truncated: boolean }): SafeHtml {
  const p = notePath(t);
  return layout(
    ctx,
    "/vault",
    TITLE,
    html`<h1>${t.note} at <code>${hash}</code></h1>${crumbs([t.space, t.project, t.section, t.note])}
${a.truncated ? html`<div class="banner warn">Output truncated.</div>` : ""}
<div class="card"><pre>${a.content}</pre></div>
<p><a href="${p}/history">Back to history</a></p>`,
  );
}
