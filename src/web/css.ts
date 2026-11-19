// Stylesheet of the web admin (served at /static/style.css). Plain CSS in a string so the
// `tsc` build ships it. CSP is `style-src 'self'`: everything is classes here, no inline style.
// Colors are tokens on :root; dark overrides apply for the OS preference (unless the user
// forced light) and for data-theme="dark".
const DARK = `
  --bg: #0f1217; --surface: #161a21; --surface-2: #1a1f27; --border: #2a303b; --border-strong: #394150; --border-soft: #222832;
  --text: #e6e9ef; --text-2: #c3c9d4; --muted: #9aa3b2; --faint: #6f7888;
  --accent: #7aa2ff; --accent-hover: #9bb9ff; --accent-text: #0b1220; --accent-soft: #1d2a4a; --accent-soft-text: #a9c2ff; --accent-line: #2d4170; --accent-wash: #151d30;
  --link: #8fb0ff; --link-hover: #b3c9ff; --hover: #1e242d; --code-bg: #1e242d; --seg-bg: #0f1217; --seg-on: #2c3442; --shadow: 0 1px 2px rgba(0,0,0,.5);
  --dark-btn: #e6e9ef; --dark-btn-text: #0f1217; --dark-btn-hover: #ffffff;
  --mark-bg: #e6e9ef; --mark-text: #0f1217;
  --p-read-bg: #1b2a44; --p-read: #9dbdf0; --p-write-bg: #3a2a14; --p-write: #ffb36b; --p-propose-bg: #2d2347; --p-propose: #c9b0f5;
  --ok-bg: #14301f; --ok: #7fd99b; --warn-bg: #3a2e10; --warn: #f0c36b; --err-bg: #3f1d1a; --err: #ff9b90; --mute-bg: #262c37; --mute: #aeb6c4;
  --danger: #ff9b90; --danger-line: #6a3430; --danger-wash: #2a1816; --danger-solid: #e5484d; --danger-solid-hover: #f26a6e; --danger-solid-text: #1a0807; --danger-text: #ffc2bc;
  --note-bg: #2b2412; --note-line: #5b4a1c; --note-text: #f3dba0;
  --prop-wash: #1f1a30; --prop-line: #3a2f5c;
  --disabled-bg: #2a303b; --disabled-text: #7d8696;
`;

export const CSS = `
:root {
  color-scheme: light dark;
  --bg: #f6f7f9; --surface: #ffffff; --surface-2: #fafbfc; --border: #e3e6eb; --border-strong: #d5dae1; --border-soft: #eef0f3;
  --text: #161a22; --text-2: #3b4252; --muted: #5a6272; --faint: #8a93a3;
  --accent: #2456d3; --accent-hover: #1c47b3; --accent-text: #ffffff; --accent-soft: #eaf0fd; --accent-soft-text: #1a3fa0; --accent-line: #c9d6f5; --accent-wash: #f5f8ff;
  --link: #2456d3; --link-hover: #1a3fa0; --hover: #f2f4f7; --code-bg: #f2f4f7; --seg-bg: #edeff3; --seg-on: #ffffff; --shadow: 0 1px 2px rgba(16,24,40,.14);
  --dark-btn: #161a22; --dark-btn-text: #ffffff; --dark-btn-hover: #2b3240;
  --mark-bg: #161a22; --mark-text: #ffffff;
  --p-read-bg: #e8eef8; --p-read: #264a80; --p-write-bg: #ffeedd; --p-write: #8f3f00; --p-propose-bg: #f0e9fc; --p-propose: #5527a8;
  --ok-bg: #e3f3e8; --ok: #11632f; --warn-bg: #fff1d1; --warn: #7a4e00; --err-bg: #fde7e4; --err: #a3201a; --mute-bg: #edeff3; --mute: #4a5262;
  --danger: #b42318; --danger-line: #ebc2bd; --danger-wash: #fdf3f2; --danger-solid: #b42318; --danger-solid-hover: #951c13; --danger-solid-text: #ffffff; --danger-text: #5c2a26;
  --note-bg: #fff8e6; --note-line: #f3dfa8; --note-text: #5c3d00;
  --prop-wash: #f8f5fe; --prop-line: #e2d6f8;
  --disabled-bg: #b9c6ec; --disabled-text: #ffffff;
  --sans: Inter, system-ui, -apple-system, "Segoe UI", sans-serif;
  --mono: "JetBrains Mono", ui-monospace, monospace;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {${DARK}}
}
:root[data-theme="light"] { color-scheme: light; }
:root[data-theme="dark"] { color-scheme: dark;${DARK}}

* { box-sizing: border-box; }
::placeholder { color: var(--muted); opacity: 1; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.5 var(--sans); }
a { color: var(--link); }
a:hover { color: var(--link-hover); }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
h1 { margin: 0; font-size: 24px; line-height: 1.25; font-weight: 600; letter-spacing: -0.01em; }
h2 { margin: 0; font-size: 16px; font-weight: 600; }
h2.sm { font-size: 15px; }
p { margin: 0; }
code, pre, .mono { font-family: var(--mono); font-size: 13px; }
code { background: var(--code-bg); padding: 1px 5px; border-radius: 4px; overflow-wrap: anywhere; }
pre { background: var(--code-bg); padding: 12px 14px; border-radius: 8px; overflow-x: auto; white-space: pre-wrap; overflow-wrap: anywhere; margin: 0; line-height: 1.6; }
.diff span { display: block; }
.diff .d-add { background: var(--ok-bg); color: var(--ok); }
.diff .d-del { background: var(--err-bg); color: var(--err); }
.diff .d-hunk { color: var(--muted); }
.muted, .hint { color: var(--muted); }
.hint { font-size: 13px; }
.dev { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 16px; padding: 12px 16px; }
.dev + .dev { border-top: 1px solid var(--border-soft); }
.anchor { scroll-margin-top: 16px; }
.small { font-size: 12px; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
[hidden] { display: none !important; }
.inline { display: inline; }
.nowrap { white-space: nowrap; }

/* ---- shell ---- */
.app { display: flex; flex-wrap: wrap; min-height: 100vh; }
.side { flex: 1 1 240px; display: flex; flex-direction: column; gap: 24px; padding: 20px 12px; background: var(--surface); border-right: 1px solid var(--border); }
.brand { display: flex; align-items: center; gap: 10px; padding: 0 8px; text-decoration: none; color: var(--text); }
.brand:hover { color: var(--text); }
.brand-mark { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border-radius: 8px; background: var(--mark-bg); color: var(--mark-text); }
.brand-name { display: flex; flex-direction: column; line-height: 1.15; }
.brand-name b { font-size: 15px; font-weight: 600; }
.brand-name span { font-size: 12px; color: var(--muted); }
.nav { display: flex; flex-wrap: wrap; gap: 2px; }
.nav a { display: flex; align-items: center; gap: 10px; height: 36px; padding: 0 10px; border-radius: 8px; text-decoration: none; font-size: 14px; font-weight: 500; flex: 1 1 180px; color: var(--text-2); }
.nav a:hover { background: var(--hover); color: var(--text); }
.nav a[aria-current="page"] { background: var(--accent-soft); color: var(--accent-soft-text); }
.nav a span.label { flex: 1; }
.count { min-width: 20px; height: 20px; padding: 0 6px; border-radius: 999px; background: var(--accent); color: var(--accent-text); font-size: 12px; font-weight: 600; display: inline-flex; align-items: center; justify-content: center; }
.side-foot { margin-top: auto; display: flex; flex-direction: column; gap: 12px; padding: 12px 8px 0; border-top: 1px solid var(--border-soft); }
.version { font-size: 12px; color: var(--muted); font-family: var(--mono); }
.who { display: flex; align-items: center; gap: 10px; min-width: 0; }
.avatar { width: 28px; height: 28px; flex: none; border-radius: 50%; background: var(--seg-bg); color: var(--text-2); font-size: 12px; font-weight: 600; display: inline-flex; align-items: center; justify-content: center; text-transform: uppercase; }
.who-text { display: flex; flex-direction: column; line-height: 1.2; min-width: 0; }
.who-text b { font-size: 13px; font-weight: 500; overflow-wrap: anywhere; }
.who-text span { font-size: 12px; color: var(--muted); }
.theme { display: flex; padding: 3px; gap: 2px; background: var(--seg-bg); border-radius: 9px; }
.theme button { flex: 1; height: 28px; padding: 0 8px; border: 0; border-radius: 7px; background: transparent; font: 500 12px/1 var(--sans); color: var(--muted); cursor: pointer; }
.theme button[aria-pressed="true"] { background: var(--seg-on); color: var(--text); box-shadow: var(--shadow); }
.main { flex: 999 1 560px; min-width: 0; padding: 32px clamp(16px, 4vw, 40px) 64px; }
.wrap { max-width: 1120px; margin: 0 auto; display: flex; flex-direction: column; gap: 20px; }
.wrap.narrow { max-width: 680px; }
@media (min-width: 900px) {
  .side { position: sticky; top: 0; align-self: flex-start; height: 100vh; max-width: 260px; overflow-y: auto; }
}
.head { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: 16px; }
.head-text { display: flex; flex-direction: column; gap: 4px; max-width: 680px; min-width: 0; }
.lead { color: var(--muted); }
.back { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; text-decoration: none; color: var(--muted); width: fit-content; }
.back:hover { color: var(--text); }
.crumb { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; font-size: 13px; color: var(--muted); }
.crumb a { color: var(--muted); text-decoration: none; }
.crumb a:hover { color: var(--text); text-decoration: underline; }
.crumb strong { color: var(--text); font-weight: 500; }

/* ---- controls ---- */
.btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; height: 36px; padding: 0 14px; border-radius: 8px; font: 500 14px/1 var(--sans); border: 1px solid var(--border-strong); background: var(--surface); color: var(--text); cursor: pointer; text-decoration: none; white-space: nowrap; }
.btn:hover { background: var(--hover); color: var(--text); }
.btn-primary { background: var(--accent); border-color: var(--accent); color: var(--accent-text); }
.btn-primary:hover { background: var(--accent-hover); border-color: var(--accent-hover); color: var(--accent-text); }
.btn-dark { background: var(--dark-btn); border-color: var(--dark-btn); color: var(--dark-btn-text); }
.btn-dark:hover { background: var(--dark-btn-hover); color: var(--dark-btn-text); }
.btn-danger { color: var(--danger); border-color: var(--danger-line); }
.btn-danger:hover { background: var(--danger-wash); color: var(--danger); }
.btn-danger-solid { background: var(--danger-solid); border-color: var(--danger-solid); color: var(--danger-solid-text); }
.btn-danger-solid:hover { background: var(--danger-solid-hover); color: var(--danger-solid-text); }
.btn-ghost { border-color: transparent; background: transparent; color: var(--text-2); }
.btn-ghost:hover { background: var(--hover); }
.btn-sm { height: 30px; padding: 0 10px; font-size: 13px; }
.btn-icon { width: 32px; padding: 0; }
.btn-block { width: 100%; }
.btn:disabled, .btn[aria-disabled="true"] { background: var(--disabled-bg); border-color: var(--disabled-bg); color: var(--disabled-text); cursor: not-allowed; }
.btn-ghost:disabled { background: transparent; border-color: transparent; color: var(--faint); }
.field { height: 36px; border: 1px solid var(--border-strong); border-radius: 8px; padding: 0 12px; background: var(--surface); color: var(--text); font: 400 14px var(--sans); width: 100%; max-width: 100%; }
.field:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
.field:disabled { background: var(--hover); color: var(--muted); }
select.field { padding-right: 28px; }
textarea.field { height: auto; padding: 8px 12px; font: 13px/1.5 var(--mono); min-height: 110px; }
textarea.wide { min-height: 420px; }
textarea.cmd { min-height: 0; }
.field.w420 { max-width: 420px; }
.field.w560 { max-width: 560px; }
.lbl, label.lbl { font-weight: 600; font-size: 14px; display: block; }
.stack { display: flex; flex-direction: column; gap: 8px; }
.stack.g12 { gap: 12px; }
.stack.g16 { gap: 16px; }
.stack.g4 { gap: 4px; }
.row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.row.g12 { gap: 12px; }
.row.between { justify-content: space-between; }
.actions { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; }
.check { display: flex; gap: 10px; align-items: flex-start; cursor: pointer; font-weight: 400; }
.check input { width: 16px; height: 16px; margin-top: 2px; accent-color: var(--accent); flex: none; }
.search { position: relative; display: block; flex: 0 1 300px; min-width: 200px; }
.search svg { position: absolute; left: 11px; top: 10px; color: var(--muted); }
.search .field { padding-left: 34px; }
.seg { display: inline-flex; padding: 3px; gap: 2px; background: var(--seg-bg); border-radius: 9px; flex-wrap: wrap; }
.seg a, .seg button { height: 30px; padding: 0 12px; border: 0; border-radius: 7px; background: transparent; font: 500 13px/1 var(--sans); color: var(--muted); cursor: pointer; display: inline-flex; align-items: center; gap: 6px; text-decoration: none; }
.seg a:hover, .seg button:hover { color: var(--text); }
.seg [aria-pressed="true"], .seg [aria-current="true"], .seg [aria-current="page"] { background: var(--seg-on); color: var(--text); box-shadow: var(--shadow); }
.seg .n { font-size: 12px; font-variant-numeric: tabular-nums; }

/* ---- cards, banners, badges ---- */
.card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; min-width: 0; }
.pad { padding: 20px; }
.pad-sm { padding: 16px 20px; }
.card.clip { overflow: hidden; }
.banner { display: flex; flex-direction: column; gap: 4px; padding: 12px 14px; border-radius: 10px; border: 1px solid var(--border); background: var(--surface); }
.banner ul { margin: 4px 0 0; padding-left: 20px; }
.banner.ok { background: var(--ok-bg); color: var(--ok); border-color: transparent; }
.banner.err { background: var(--err-bg); color: var(--err); border-color: transparent; }
.banner.warn { background: var(--warn-bg); color: var(--warn); border-color: transparent; }
.banner.live { flex-direction: row; align-items: center; justify-content: space-between; gap: 12px; }
.note { padding: 12px; border-radius: 10px; background: var(--note-bg); border: 1px solid var(--note-line); color: var(--note-text); font-size: 13px; }
.note ul { margin: 0; padding-left: 18px; }
.callout { display: flex; flex-wrap: wrap; align-items: center; gap: 16px; padding: 16px 20px; border: 1px solid var(--accent-line); background: var(--accent-wash); border-radius: 12px; }
.callout .ico { width: 36px; height: 36px; border-radius: 10px; background: var(--accent); color: var(--accent-text); display: inline-flex; align-items: center; justify-content: center; flex: none; }
.callout .body { flex: 1 1 280px; display: flex; flex-direction: column; min-width: 0; }
.callout.prop { background: var(--prop-wash); border-color: var(--prop-line); }
.callout.prop .ico { background: var(--p-propose); color: var(--prop-wash); }
.confirm { padding: 12px 14px; border-radius: 10px; background: var(--danger-wash); border: 1px solid var(--danger-line); display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
.confirm strong { color: var(--danger); font-weight: 600; }
.badge { display: inline-flex; align-items: center; gap: 6px; height: 22px; padding: 0 8px; border-radius: 999px; font: 500 12px/1 var(--sans); white-space: nowrap; background: var(--mute-bg); color: var(--mute); }
.badge.ok { background: var(--ok-bg); color: var(--ok); }
.badge.warn { background: var(--warn-bg); color: var(--warn); }
.badge.err { background: var(--err-bg); color: var(--err); }
.badge.prop { background: var(--p-propose-bg); color: var(--p-propose); }
.dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.scope { display: inline-flex; align-items: stretch; height: 24px; border-radius: 6px; overflow: hidden; border: 1px solid var(--border); font: 500 12px/22px var(--mono); white-space: nowrap; max-width: 100%; }
.scope-path { padding: 0 8px; background: var(--bg); color: var(--text-2); overflow: hidden; text-overflow: ellipsis; }
.scope-perm { padding: 0 8px; }
.p-read { background: var(--p-read-bg); color: var(--p-read); }
.p-write { background: var(--p-write-bg); color: var(--p-write); }
.p-propose { background: var(--p-propose-bg); color: var(--p-propose); }
.permtag { display: inline-block; width: fit-content; padding: 0 6px; border-radius: 4px; font: 500 11px/18px var(--mono); white-space: nowrap; }
.act { font: 500 12px/20px var(--mono); padding: 0 6px; border-radius: 5px; background: var(--code-bg); color: var(--text-2); }

/* ---- tables ---- */
.scroll { overflow-x: auto; }
table.tbl { width: 100%; border-collapse: collapse; }
.tbl th { text-align: left; padding: 12px 16px; font: 500 12px/1 var(--sans); color: var(--muted); background: var(--surface-2); border-bottom: 1px solid var(--border); white-space: nowrap; }
.tbl td { padding: 12px 16px; border-top: 1px solid var(--border-soft); vertical-align: top; }
.tbl tbody tr:first-child td { border-top: 0; }
.tbl tr.is-revoked .nm { color: var(--muted); text-decoration: line-through; }
.tbl tr.is-revoked .scope { opacity: .65; }
.tbl.compact td { padding: 9px 16px; vertical-align: middle; }
.tbl .num { text-align: right; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.empty { padding: 44px 20px; display: flex; flex-direction: column; align-items: center; gap: 6px; text-align: center; color: var(--muted); }
.empty strong { color: var(--text); font-weight: 600; }
.foot { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; padding: 12px 20px; border-top: 1px solid var(--border-soft); background: var(--surface-2); color: var(--muted); font-size: 13px; }
.sect { padding: 8px 20px; background: var(--surface-2); border-bottom: 1px solid var(--border-soft); font: 600 12px/1.5 var(--sans); color: var(--text-2); }

/* ---- dashboard ---- */
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(220px, 100%), 1fr)); gap: 12px; }
.stat { display: flex; flex-direction: column; gap: 4px; padding: 18px 20px; text-decoration: none; color: var(--text); }
.stat:hover { border-color: var(--accent-line); color: var(--text); }
.stat .n { font-size: 28px; font-weight: 600; line-height: 1.2; font-variant-numeric: tabular-nums; }
.cols { display: flex; flex-wrap: wrap; gap: 16px; align-items: flex-start; }
.cols > .c1 { flex: 1 1 320px; min-width: 0; }
.cols > .c2 { flex: 2 1 420px; min-width: 0; }
.kv { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 10px 0; border-top: 1px solid var(--border-soft); }
.kv:first-of-type { border-top: 0; }
.kv > :last-child { text-align: right; min-width: 0; overflow-wrap: anywhere; }
.ev { display: grid; grid-template-columns: 64px minmax(0, 1fr) auto; gap: 12px; align-items: center; padding: 10px 0; border-top: 1px solid var(--border-soft); }
.ev:first-of-type { border-top: 0; }
.ev .what { display: flex; flex-wrap: wrap; gap: 6px 8px; align-items: center; min-width: 0; }
.ev .tgt { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }

/* ---- filters / audit ---- */
.filters { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
.filters .field { flex: 0 1 190px; width: auto; }
.filters .grow { flex: 1 1 220px; }
.fchip { display: inline-flex; align-items: center; gap: 4px; height: 28px; padding: 0 4px 0 10px; border-radius: 999px; background: var(--accent-soft); color: var(--accent-soft-text); font: 500 13px/1 var(--sans); }
.fchip a { width: 22px; height: 22px; border-radius: 50%; color: inherit; display: inline-flex; align-items: center; justify-content: center; }
.fchip a:hover { background: var(--accent-line); }
.trunc { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 260px; display: inline-block; vertical-align: bottom; }

/* ---- inbox ---- */
.split { display: flex; flex-wrap: wrap; gap: 16px; align-items: flex-start; }
.split > .list { flex: 1 1 300px; min-width: 0; }
.split > .detail { flex: 999 1 520px; min-width: 0; }
.list-head { padding: 12px 16px; border-bottom: 1px solid var(--border); background: var(--surface-2); font: 500 12px/1 var(--sans); color: var(--muted); }
.item { display: flex; flex-direction: column; gap: 4px; padding: 14px 16px; border-left: 3px solid transparent; border-top: 1px solid var(--border-soft); text-decoration: none; color: var(--text); }
.list-head + .item { border-top: 0; }
.item:hover { background: var(--surface-2); color: var(--text); }
.item[aria-current="page"] { background: var(--accent-wash); border-left-color: var(--accent); }
.item b { font-weight: 600; overflow-wrap: anywhere; }
.item .meta { display: flex; gap: 6px; flex-wrap: wrap; font-size: 13px; color: var(--muted); }
.quote { margin: 0; padding: 10px 14px; border-radius: 8px; background: var(--bg); color: var(--text-2); }
.quote .hint { display: block; font-size: 12px; }
.dhead { padding: 18px 20px; border-bottom: 1px solid var(--border); display: flex; flex-direction: column; gap: 12px; }
.dbody { padding: 18px 20px 24px; }

/* ---- vault ---- */
.vgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(220px, 100%), 1fr)); gap: 12px; }
.vtile { display: flex; align-items: center; gap: 10px; padding: 14px 16px; text-decoration: none; color: var(--text); font-weight: 500; }
.vtile:hover { border-color: var(--accent-line); color: var(--accent-soft-text); }
.vtile svg { color: var(--muted); flex: none; }
.nrow { display: grid; grid-template-columns: minmax(0, 1fr) 90px 150px; gap: 16px; align-items: center; padding: 12px 20px; border-top: 1px solid var(--border-soft); text-decoration: none; color: var(--text); }
a.nrow:hover { background: var(--surface-2); color: var(--text); }
.nrow.head { background: var(--surface-2); border-top: 0; border-bottom: 1px solid var(--border); font: 500 12px/1 var(--sans); color: var(--muted); padding-top: 10px; padding-bottom: 10px; }
.nrow .nm { display: flex; align-items: center; gap: 10px; min-width: 0; font-weight: 500; color: var(--accent-soft-text); overflow-wrap: anywhere; }
.nrow.head .nm { color: var(--muted); font-weight: 500; }
@media (max-width: 560px) { .nrow { grid-template-columns: minmax(0, 1fr) auto; } .nrow > :nth-child(3) { display: none; } }
.noteview { display: flex; flex-wrap: wrap; gap: 20px; align-items: flex-start; }

/* ---- markdown ---- */
.md { color: var(--text); font-size: 15px; line-height: 1.7; overflow-wrap: anywhere; }
.md > :first-child { margin-top: 0; }
.md h1 { font-size: 26px; line-height: 1.25; margin: 0 0 12px; font-weight: 700; letter-spacing: -0.015em; }
.md h2 { font-size: 20px; line-height: 1.3; margin: 28px 0 10px; font-weight: 600; padding-bottom: 6px; border-bottom: 1px solid var(--border-soft); }
.md h3 { font-size: 17px; margin: 22px 0 8px; font-weight: 600; }
.md p { margin: 0 0 14px; }
.md blockquote { margin: 0 0 16px; padding: 10px 16px; border-radius: 8px; background: var(--bg); color: var(--text-2); }
.md ol, .md ul { margin: 0 0 14px; padding-left: 24px; }
.md li { margin: 3px 0; }
.md pre { margin: 0 0 16px; padding: 14px 16px; border-radius: 10px; background: var(--code-bg); }
.md pre code { background: none; padding: 0; }
.md table { border-collapse: collapse; width: 100%; margin: 0 0 16px; font-size: 14px; display: block; overflow-x: auto; }
.md th { text-align: left; font-weight: 600; padding: 8px 12px; border-bottom: 2px solid var(--border-strong); }
.md td { padding: 8px 12px; border-bottom: 1px solid var(--border); }
.md img { max-width: 100%; }
.md hr { border: 0; border-top: 1px solid var(--border); margin: 20px 0; }

/* ---- new token ---- */
.ntf { display: flex; flex-wrap: wrap; gap: 20px; align-items: flex-start; }
.ntf-main { flex: 999 1 560px; min-width: 0; display: flex; flex-direction: column; gap: 16px; }
.ntf-side { flex: 1 1 320px; min-width: 0; display: flex; flex-direction: column; gap: 16px; }
.tpl-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(200px, 100%), 1fr)); gap: 10px; border: 0; padding: 0; margin: 0; min-width: 0; }
.tpl { position: relative; display: block; cursor: pointer; }
.tpl input { position: absolute; opacity: 0; inset: 0; margin: 0; cursor: pointer; }
.tpl-box { display: flex; flex-direction: column; gap: 2px; height: 100%; padding: 12px 14px; border: 1px solid var(--border); border-radius: 10px; background: var(--surface); }
.tpl:hover .tpl-box { border-color: var(--border-strong); }
.tpl input:checked + .tpl-box { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); background: var(--accent-wash); }
.tpl input:focus-visible + .tpl-box { outline: 2px solid var(--accent); outline-offset: 2px; }
.tpl-box b { font-weight: 600; font-size: 14px; }
.chipset { display: flex; flex-wrap: wrap; gap: 8px; border: 0; padding: 0; margin: 0; min-width: 0; }
.chip { position: relative; display: inline-flex; cursor: pointer; }
.chip input { position: absolute; opacity: 0; inset: 0; margin: 0; cursor: pointer; }
.chip span { height: 32px; padding: 0 12px; border: 1px solid var(--border-strong); border-radius: 999px; background: var(--surface); font: 500 13px/1 var(--sans); color: var(--text-2); display: inline-flex; align-items: center; }
.chip input:checked + span { background: var(--dark-btn); border-color: var(--dark-btn); color: var(--dark-btn-text); }
.chip input:focus-visible + span { outline: 2px solid var(--accent); outline-offset: 2px; }
.srow { border: 1px solid var(--border); border-radius: 10px; background: var(--surface-2); padding: 12px; display: flex; flex-direction: column; gap: 10px; }
.srow .line { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.srow select.field { flex: 1 1 140px; width: auto; }
.srow .sep { color: var(--faint); font-family: var(--mono); }
.srow .desc { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 13px; color: var(--text-2); }
.fold { border-top: 1px solid var(--border-soft); padding-top: 14px; }
.fold > summary .hint { font-weight: 400; }
.fold > summary { display: flex; align-items: center; gap: 8px; font-weight: 600; cursor: pointer; list-style: none; }
.fold > summary::-webkit-details-marker { display: none; }
.fold > summary::after { content: ""; margin-left: auto; width: 8px; height: 8px; border-right: 2px solid var(--muted); border-bottom: 2px solid var(--muted); transform: rotate(45deg); }
.fold[open] > summary::after { transform: rotate(-135deg); }
.fold .body { display: flex; flex-direction: column; gap: 14px; padding-top: 14px; }
.anat { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 6px; }
.anat div { display: flex; flex-direction: column; gap: 4px; align-items: center; }
.anat .part { padding: 4px 10px; border-radius: 6px; background: var(--bg); border: 1px solid var(--border); font: 13px var(--mono); }
.anat .colon { padding-top: 4px; color: var(--faint); font-family: var(--mono); }
.perm-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(220px, 100%), 1fr)); gap: 12px; }
.sum-can { display: flex; gap: 8px; align-items: flex-start; }
.sum-can .permtag { margin-top: 3px; flex: none; }
#builder { flex-direction: column; align-items: flex-start; gap: 12px; }
.js-only { display: none; }
.js .js-only { display: block; }
.js #builder.js-only { display: flex; }
.js .no-js { display: none; }

/* ---- token created ---- */
.okmark { width: 40px; height: 40px; border-radius: 50%; background: var(--ok-bg); color: var(--ok); display: inline-flex; align-items: center; justify-content: center; flex: none; }
.once { border-color: var(--note-line); box-shadow: 0 0 0 3px var(--note-bg); }
.secret { flex: 1 1 320px; min-width: 0; font: 14px var(--mono); }
.status { font-size: 13px; color: var(--muted); }
.grant { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
`;
