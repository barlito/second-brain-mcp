// Vault browser pages. Paths are built only from validated slugs; everything is escaped.
import type { Listing, NoteRef, ShownNote } from "../admin/vault";
import type { NoteHistoryEntry } from "../vault/git";
import { html, raw, SafeHtml } from "./html";
import { Banner, bannerView, csrfField, Ctx, fmtSize, ICON, layout, relTime, renderMd } from "./views";

const TITLE = "Vault";
const atUrl = (p: string, e: NoteHistoryEntry): string => `${p}/at/${e.hash}?path=${encodeURIComponent(e.path)}`;
const notePath = (t: NoteRef): string => `/vault/${t.space}/${t.project}/${t.section}/${t.note}`;

// parts: [] .. [space, project, section, note]; the last one is the current page.
function crumbs(parts: string[], lastIsLink = false): SafeHtml {
  const items = [html`<a href="/vault">vault</a>`];
  parts.forEach((p, i) => {
    const last = i === parts.length - 1 && !lastIsLink;
    items.push(last ? html`<strong>${p}</strong>` : html`<a href="/vault/${parts.slice(0, i + 1).join("/")}">${p}</a>`);
  });
  return html`<nav aria-label="Breadcrumb" class="crumb">${items.map((c, i) => html`${i ? html`<span aria-hidden="true">/</span>` : ""}${c}`)}</nav>`;
}

const LEVELS = ["Spaces", "Projects", "Sections"];

export function browseView(ctx: Ctx, parts: string[], l: Listing, banner?: Banner): SafeHtml {
  const base = parts.length ? `/vault/${parts.join("/")}/` : "/vault/";
  const title = parts.length ? parts[parts.length - 1] : "Vault";
  const body =
    l.kind === "dirs"
      ? l.names.length === 0
        ? html`<div class="card empty"><strong>Nothing here</strong></div>`
        : html`<div class="vgrid">${l.names.map((n) => html`<a class="card vtile" href="${base}${n}">${ICON.folder}<span>${n}</span></a>`)}</div>`
      : html`<div class="card clip">
<div class="nrow head"><span class="nm">Note</span><span>Size</span><span>Modified</span></div>
${
          l.notes.length === 0
            ? html`<div class="empty"><strong>No notes</strong></div>`
            : l.notes.map((n) => html`<a class="nrow" href="${base}${n.name}"><span class="nm">${ICON.file}<span>${n.name}</span></span><span class="hint">${fmtSize(n.size)}</span><span class="hint" title="${n.mtime.toISOString()}">${relTime(n.mtime.toISOString())}</span></a>`)
        }</div>`;
  return layout(
    ctx,
    "/vault",
    TITLE,
    html`<div class="stack">${crumbs(parts)}<div class="head"><div class="head-text"><h1>${title}</h1>${parts.length < 3 ? html`<p class="lead">${LEVELS[parts.length]}</p>` : ""}</div>${
      l.kind === "notes" ? html`<a class="btn btn-primary" href="${base}_new">${ICON.plus}New note</a>` : ""
    }</div></div>
${bannerView(banner)}
${body}`,
  );
}

export function noteView(ctx: Ctx, t: NoteRef, n: ShownNote, mode: "rendered" | "raw", banner?: Banner): SafeHtml {
  const p = notePath(t);
  return layout(
    ctx,
    "/vault",
    TITLE,
    html`<div class="stack g12">${crumbs([t.space, t.project, t.section], true)}
<div class="head"><div class="head-text"><h1>${t.note}</h1>
<div class="row g12 hint"><span>${fmtSize(n.size)}</span>${
      n.last
        ? html`<span>last commit <a class="mono small" href="${atUrl(p, n.last)}">${n.last.sha}</a> <span title="${n.last.date}">${relTime(n.last.date)}</span> ${n.last.subject}</span>`
        : html`<span>no commits yet</span>`
    }</div></div>
${
      n.writable
        ? html`<div class="row">
<a class="btn" href="${p}/history">${ICON.history}History</a>
<form method="post" action="${p}/archive" class="inline" data-confirm="Archive this note? It moves to the archive section (history is kept).">${csrfField(ctx)}<button class="btn" type="submit">${ICON.archive}Archive</button></form>
${n.editable ? html`<a class="btn btn-primary" href="${p}/edit">${ICON.edit}Edit</a>` : ""}
</div>`
        : html`<div class="row"><a class="btn" href="${p}/history">${ICON.history}History</a></div>`
    }
</div></div>
${bannerView(banner)}
${n.writable && !n.editable ? html`<p class="muted">Not valid UTF-8: edit it in git.</p>` : ""}
${n.writable ? "" : html`<p class="muted">Archived notes are read-only.</p>`}
<article class="card clip">
<div class="pad-sm"><div class="seg" role="group" aria-label="View">
<a href="${p}"${mode === "rendered" ? raw(' aria-current="page"') : ""}>Rendered</a>
<a href="${p}?view=raw"${mode === "raw" ? raw(' aria-current="page"') : ""}>Markdown</a>
</div></div>
<div class="pad">${mode === "raw" ? html`<pre>${n.content}</pre>` : html`<div class="md">${renderMd(n.content)}</div>`}</div>
</article>`,
  );
}

const textarea = (content: string): SafeHtml =>
  // The HTML parser drops one leading newline in a textarea: add one back.
  html`<textarea class="field wide" id="content" name="content" spellcheck="false">${raw("\n")}${content}</textarea>`;

export function editView(ctx: Ctx, t: NoteRef, content: string, base: string, banner?: Banner, stale = false): SafeHtml {
  const p = notePath(t);
  return layout(
    ctx,
    "/vault",
    TITLE,
    html`<div class="stack g12">${crumbs([t.space, t.project, t.section, t.note], true)}<h1>Edit ${t.note}</h1></div>${bannerView(banner)}
<form method="post" action="${p}/edit" class="card pad stack g12">
${stale ? html`<p><a href="${p}" target="_blank" rel="noopener">View the current note in a new page</a> to copy changes; saving here is refused until you reload the editor.</p>` : ""}
${csrfField(ctx)}<input type="hidden" name="base" value="${base}">
<label class="lbl" for="content">Content</label>
${textarea(content)}
<div class="actions"><button class="btn btn-primary" type="submit">Save</button><a class="btn btn-ghost" href="${p}">Cancel</a></div>
</form>`,
  );
}

export function newView(ctx: Ctx, t: Omit<NoteRef, "note">, name: string, content: string, banner?: Banner): SafeHtml {
  const dir = `/vault/${t.space}/${t.project}/${t.section}`;
  return layout(
    ctx,
    "/vault",
    TITLE,
    html`<div class="stack g12">${crumbs([t.space, t.project, t.section], true)}<h1>New note</h1></div>${bannerView(banner)}
<form method="post" action="${dir}/_new" class="card pad stack g12">
${csrfField(ctx)}
<div class="stack"><label class="lbl" for="note">Name <span class="hint">(slug: a-z, 0-9, hyphens; max 64; becomes <code>name.md</code>)</span></label>
<input class="field w420" type="text" id="note" name="note" maxlength="64" required value="${name}"></div>
<label class="lbl" for="content">Content</label>
${textarea(content)}
<div class="actions"><button class="btn btn-primary" type="submit">Create</button><a class="btn btn-ghost" href="${dir}">Cancel</a></div>
</form>`,
  );
}

export function historyView(ctx: Ctx, t: NoteRef, entries: NoteHistoryEntry[]): SafeHtml {
  const p = notePath(t);
  return layout(
    ctx,
    "/vault",
    TITLE,
    html`<div class="stack g12">${crumbs([t.space, t.project, t.section, t.note], true)}<h1>History: ${t.note}</h1><a class="back" href="${p}">${ICON.back}Back to the note</a></div>
<div class="card clip"><div class="scroll"><table class="tbl compact">
<thead><tr><th>Commit</th><th>Date</th><th>Author</th><th>Subject</th><th></th></tr></thead>
<tbody>${
      entries.length === 0
        ? html`<tr><td colspan="5"><div class="empty"><strong>No commits yet</strong></div></td></tr>`
        : entries.map((e) => html`<tr><td><a href="${atUrl(p, e)}"><code>${e.sha}</code></a></td><td class="mono small nowrap">${e.date}</td><td>${e.author}</td><td>${e.subject}</td><td class="nowrap"><a href="${p}/at/${e.hash}/diff">Diff</a></td></tr>`)
    }</tbody></table></div></div>`,
  );
}

const versionActions = (ctx: Ctx, p: string, hash: string, canRestore: boolean, other: SafeHtml): SafeHtml =>
  html`<div class="row">${other}${
    canRestore
      ? html`<form method="post" action="${p}/at/${hash}/restore" class="inline" data-confirm="Restore this version? It becomes the current content (a new commit; history is kept).">${csrfField(ctx)}<button class="btn" type="submit">${ICON.history}Restore this version</button></form>`
      : ""
  }</div>`;

export function atView(ctx: Ctx, t: NoteRef, hash: string, canRestore: boolean, a: { content: string; truncated: boolean }): SafeHtml {
  const p = notePath(t);
  return layout(
    ctx,
    "/vault",
    TITLE,
    html`<div class="stack g12">${crumbs([t.space, t.project, t.section, t.note], true)}<h1>${t.note} at <code>${hash.slice(0, 7)}</code></h1><a class="back" href="${p}/history">${ICON.back}Back to history</a>
${versionActions(ctx, p, hash, canRestore, html`<a class="btn" href="${p}/at/${hash}/diff">Diff with current</a>`)}</div>
${a.truncated ? html`<div class="banner warn">Output truncated.</div>` : ""}
<div class="card pad"><pre>${a.content}</pre></div>`,
  );
}

const diffClass = (l: string): string => (l.startsWith("@@") ? "d-hunk" : l.startsWith("+") ? "d-add" : l.startsWith("-") ? "d-del" : "d-ctx");

export function diffView(ctx: Ctx, t: NoteRef, hash: string, canRestore: boolean, d: { diff: string; truncated: boolean }, banner?: Banner): SafeHtml {
  const p = notePath(t);
  const lines = d.diff.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return layout(
    ctx,
    "/vault",
    TITLE,
    html`<div class="stack g12">${crumbs([t.space, t.project, t.section, t.note], true)}<h1>${t.note}: <code>${hash.slice(0, 7)}</code> vs current</h1><a class="back" href="${p}/history">${ICON.back}Back to history</a>
${versionActions(ctx, p, hash, canRestore, html`<a class="btn" href="${p}/at/${hash}">View this version</a>`)}</div>
${bannerView(banner)}
${d.truncated ? html`<div class="banner warn">Output truncated.</div>` : ""}
<div class="card pad">${lines.length === 0 ? html`<p class="muted">No differences: the current version is identical.</p>` : html`<pre class="diff">${lines.map((l) => html`<span class="${diffClass(l)}">${l}</span>`)}</pre>`}</div>`,
  );
}
