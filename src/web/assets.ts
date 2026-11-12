// Static assets served at /static/*. Kept as strings so the plain `tsc` build ships them.
export const CSS = `
:root {
  --bg: #f6f7f9; --surface: #fff; --text: #1d2330; --muted: #5d6677; --border: #d9dde5;
  --accent: #2456d3; --accent-text: #fff; --danger: #b42318; --ok: #14733a; --warn: #8a5a00;
  --ok-bg: #e6f4ea; --err-bg: #fdecea; --warn-bg: #fff4d6; --code-bg: #eef0f4;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #14171d; --surface: #1c2029; --text: #e6e9ef; --muted: #9aa3b2; --border: #323846;
    --accent: #6f9bff; --accent-text: #0c1220; --danger: #ff8a80; --ok: #6fd58f; --warn: #f0c36b;
    --ok-bg: #16301f; --err-bg: #3a1c1a; --warn-bg: #3a2f14; --code-bg: #262b36;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, sans-serif; }
header { background: var(--surface); border-bottom: 1px solid var(--border); }
header .bar { max-width: 1000px; margin: 0 auto; padding: 0 16px; display: flex; gap: 20px; align-items: center; flex-wrap: wrap; }
header .brand { font-weight: 700; padding: 12px 0; }
header nav { display: flex; gap: 4px; flex: 1; }
header nav a { padding: 12px 10px; color: var(--muted); text-decoration: none; border-bottom: 2px solid transparent; }
header nav a[aria-current="page"] { color: var(--text); border-color: var(--accent); }
header .who { color: var(--muted); font-size: 13px; }
main { max-width: 1000px; margin: 0 auto; padding: 20px 16px 60px; }
h1 { font-size: 22px; margin: 0 0 16px; }
h2 { font-size: 17px; margin: 24px 0 8px; }
a { color: var(--accent); }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 14px 16px; margin-bottom: 16px; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 12px; margin-bottom: 16px; }
.stat { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; }
.stat .n { font-size: 26px; font-weight: 700; }
.stat .l { color: var(--muted); font-size: 13px; }
table { width: 100%; border-collapse: collapse; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; }
th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--border); vertical-align: top; }
th { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
tr:last-child td { border-bottom: 0; }
.scroll { overflow-x: auto; }
code, pre, .mono { font-family: ui-monospace, monospace; font-size: 13px; }
code { background: var(--code-bg); padding: 1px 5px; border-radius: 4px; }
pre { background: var(--code-bg); padding: 12px; border-radius: 6px; overflow-x: auto; white-space: pre-wrap; word-break: break-word; }
.muted { color: var(--muted); }
.badge { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 12px; background: var(--code-bg); }
.code { font-size: 28px; letter-spacing: 4px; font-family: ui-monospace, monospace; }
.badge.ok { background: var(--ok-bg); color: var(--ok); }
.badge.err { background: var(--err-bg); color: var(--danger); }
.badge.warn { background: var(--warn-bg); color: var(--warn); }
.banner { padding: 10px 14px; border-radius: 6px; margin-bottom: 16px; border: 1px solid var(--border); }
.banner.ok { background: var(--ok-bg); color: var(--ok); }
.banner.err { background: var(--err-bg); color: var(--danger); }
.banner.warn { background: var(--warn-bg); color: var(--warn); }
.banner ul { margin: 4px 0 0; padding-left: 20px; }
form.stack label { display: block; margin: 12px 0 4px; font-weight: 600; }
form.stack .hint { color: var(--muted); font-size: 13px; font-weight: 400; }
input[type=text], textarea, select { width: 100%; max-width: 560px; padding: 8px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); color: var(--text); font: inherit; }
textarea { font-family: ui-monospace, monospace; font-size: 13px; min-height: 110px; }
.check { display: flex; gap: 8px; align-items: center; margin: 12px 0; font-weight: 400 !important; }
button { font: inherit; padding: 7px 14px; border-radius: 6px; border: 1px solid var(--border); background: var(--surface); color: var(--text); cursor: pointer; }
button.primary { background: var(--accent); color: var(--accent-text); border-color: var(--accent); }
button.danger { color: var(--danger); border-color: var(--danger); }
.actions { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; margin-top: 12px; }
.inline { display: inline; }
.flush { margin-top: 0; }
.token { word-break: break-all; font-size: 14px; padding: 12px; background: var(--code-bg); border-radius: 6px; user-select: all; }
.md { overflow-wrap: anywhere; }
.md img { max-width: 100%; }
textarea.cmd { max-width: 100%; min-height: 0; }
textarea.wide { max-width: 100%; min-height: 380px; }
.crumbs { color: var(--muted); margin: -8px 0 16px; }
.tabs { display: flex; gap: 8px; margin: 12px 0 8px; }
.tabs a { text-decoration: none; padding: 4px 10px; border-radius: 6px; border: 1px solid var(--border); color: var(--text); }
.tabs a[aria-current="page"] { background: var(--accent); color: var(--accent-text); border-color: var(--accent); }
`;

// Confirm dialogs for forms carrying data-confirm (CSP forbids inline handlers).
export const JS = `document.addEventListener("submit", function (e) {
  var m = e.target && e.target.getAttribute && e.target.getAttribute("data-confirm");
  if (m && !window.confirm(m)) e.preventDefault();
});

// Copy button: Clipboard API, falling back to select-all + execCommand for non-secure contexts.
document.addEventListener("click", function (e) {
  var b = e.target && e.target.closest ? e.target.closest("[data-copy]") : null;
  if (!b) return;
  var el = document.getElementById(b.getAttribute("data-copy"));
  var st = document.getElementById(b.getAttribute("data-copy") + "-status");
  if (!el) return;
  function say(t) { if (st) st.textContent = t; }
  function fallback() {
    el.focus();
    el.select();
    var ok = false;
    try { ok = document.execCommand("copy"); } catch (err) { ok = false; }
    say(ok ? "Copied." : "Selected: press Ctrl+C (Cmd+C) to copy.");
  }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(el.value).then(function () { say("Copied."); }, fallback);
  } else {
    fallback();
  }
});
`;
