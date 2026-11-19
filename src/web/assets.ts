// Static assets served at /static/*. Kept as strings so the plain `tsc` build ships them.
// JS is vanilla and external (CSP: script-src 'self'); String.raw keeps backslashes literal.
export { CSS } from "./css";

// Loaded synchronously in <head> (no defer) so the stored theme applies before first paint.
export const THEME_JS = String.raw`(function () {
  var d = document.documentElement;
  d.classList.add("js");
  try {
    var t = localStorage.getItem("sb-theme");
    if (t === "light" || t === "dark") d.setAttribute("data-theme", t);
  } catch (e) { /* storage blocked: stay on Auto */ }
})();
`;

export const JS = String.raw`document.addEventListener("submit", function (e) {
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

// Theme toggle (Auto / Light / Dark). Hidden without JS; theme.js applies the stored choice early.
(function () {
  var box = document.querySelector("[data-theme-toggle]");
  if (!box) return;
  var root = document.documentElement;
  function current() {
    var t = root.getAttribute("data-theme");
    return t === "light" || t === "dark" ? t : "auto";
  }
  function paint() {
    var c = current();
    box.querySelectorAll("button[data-theme-set]").forEach(function (b) {
      b.setAttribute("aria-pressed", b.getAttribute("data-theme-set") === c ? "true" : "false");
    });
  }
  box.hidden = false;
  box.addEventListener("click", function (e) {
    var b = e.target && e.target.closest ? e.target.closest("button[data-theme-set]") : null;
    if (!b) return;
    var v = b.getAttribute("data-theme-set");
    if (v === "light" || v === "dark") root.setAttribute("data-theme", v);
    else root.removeAttribute("data-theme");
    try {
      if (v === "auto") localStorage.removeItem("sb-theme");
      else localStorage.setItem("sb-theme", v);
    } catch (err) { /* storage blocked: applies to this page only */ }
    paint();
  });
  paint();
})();

// Token created: "I've copied and stored this token" gates the Done link.
(function () {
  var cb = document.getElementById("stored");
  var done = document.getElementById("done");
  if (!cb || !done) return;
  function sync() {
    if (cb.checked) done.removeAttribute("aria-disabled");
    else done.setAttribute("aria-disabled", "true");
  }
  done.addEventListener("click", function (e) { if (!cb.checked) e.preventDefault(); });
  cb.addEventListener("change", sync);
  sync();
})();

// New token form: scope builder + summary. The real field stays the "scopes" textarea; this only
// keeps it in sync (rows <-> text). Without JS the form still works with the textarea alone.
(function () {
  var form = document.getElementById("tokform");
  var area = document.getElementById("scopes");
  var host = document.getElementById("builder");
  if (!form || !area || !host) return;
  var SECTIONS = ["overview", "decisions", "conventions", "notes", "journal", "archive"];
  var PERMS = [["read", "Read"], ["write", "Read & write"], ["propose", "Propose"]];
  var projects = [];
  try { projects = JSON.parse(document.getElementById("sb-projects").textContent) || []; } catch (e) { projects = []; }
  var tree = {};
  projects.forEach(function (p) {
    var i = String(p).indexOf("/");
    if (i < 1) return;
    var s = p.slice(0, i), n = p.slice(i + 1);
    (tree[s] = tree[s] || []).indexOf(n) < 0 && tree[s].push(n);
  });
  var rows = [];

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function parse(text) {
    var out = [];
    text.split(/\r?\n/).forEach(function (l) {
      l = l.trim();
      if (!l) return;
      var p = l.split(":");
      if (p.length === 4 && (p[3] === "read" || p[3] === "write" || p[3] === "propose")) out.push({ s: p[0], p: p[1], sec: p[2], perm: p[3] });
    });
    return out;
  }
  var valid = function (r) { return !!(r.s && r.p && r.sec); };
  var path = function (r) { return [r.s || "?", r.p || "?", r.sec || "?"].join(":"); };
  function presetVal() {
    var c = form.querySelector('input[name="preset"]:checked');
    return c ? c.value : "";
  }
  var unbounded = function (pr) { return pr === "master" || pr === "master-ro"; };

  function describe(r) {
    if (!r.s) return "Choose a space.";
    if (!r.p) return "Choose a project in " + r.s + ".";
    var verb = r.perm === "read" ? "Read" : r.perm === "write" ? "Read & write" : "Propose changes to";
    var where;
    if (r.s === "*") where = "every note in the vault";
    else if (r.p === "*") where = "every project in " + r.s;
    else if (r.sec === "*") where = "every section of " + r.s + "/" + r.p;
    else where = r.s + "/" + r.p + "/" + r.sec + " only";
    return verb + " " + where + (path(r).indexOf("*") >= 0 ? ", including ones created later" : "") + ".";
  }
  function permLabel(p) { return p === "write" ? "read & write" : p; }

  function sync() {
    area.value = unbounded(presetVal()) ? "" : rows.filter(valid).map(function (r) { return path(r) + ":" + r.perm; }).join("\n");
    summary();
  }

  function option(sel, v, l) {
    var o = el("option", "", l);
    o.value = v;
    sel.appendChild(o);
  }
  function spaces() {
    return Object.keys(tree).sort();
  }
  function select(label, value, opts, locked, on) {
    var s = el("select", "field");
    s.setAttribute("aria-label", label);
    var seen = false;
    opts.forEach(function (o) { if (o[0] === value) seen = true; option(s, o[0], o[1]); });
    if (!seen && value) option(s, value, value);
    s.value = value;
    s.disabled = locked;
    s.addEventListener("change", function () { on(s.value); });
    return s;
  }

  function render() {
    host.textContent = "";
    var pr = presetVal();
    var hideAll = unbounded(pr);
    host.hidden = hideAll;
    var cnt = document.getElementById("scope-count");
    if (cnt) cnt.textContent = rows.length + (rows.length === 1 ? " scope" : " scopes");
    var linesBox = document.getElementById("lines-details");
    if (linesBox) linesBox.hidden = hideAll;
    var list = el("div", "stack g12");
    rows.forEach(function (r, i) {
      var box = el("div", "srow");
      var line = el("div", "line");
      var sOpts = [["", "Choose a space..."], ["*", "* (all spaces)"]].concat(spaces().map(function (k) { return [k, k]; }));
      line.appendChild(select("Space", r.s, sOpts, false, function (v) {
        r.s = v; r.p = v === "*" ? "*" : ""; r.sec = "*"; change();
      }));
      line.appendChild(el("span", "sep", ":"));
      var pOpts;
      if (r.s === "*") pOpts = [["*", "* (all projects)"]];
      else if (!r.s) pOpts = [["", "Project"]];
      else pOpts = [["", "Choose a project..."], ["*", "* (all in " + r.s + ")"]].concat((tree[r.s] || []).map(function (k) { return [k, k]; }));
      line.appendChild(select("Project", r.p, pOpts, r.s === "*" || !r.s, function (v) {
        r.p = v; if (v === "*") r.sec = "*"; change();
      }));
      line.appendChild(el("span", "sep", ":"));
      var secOpts = [["*", "* (all sections)"]];
      if (r.p && r.p !== "*") SECTIONS.forEach(function (k) { secOpts.push([k, k]); });
      line.appendChild(select("Section", r.sec, secOpts, r.p === "*" || !r.p, function (v) { r.sec = v; change(); }));
      var seg = el("div", "seg");
      seg.setAttribute("role", "group");
      seg.setAttribute("aria-label", "Permission");
      PERMS.forEach(function (pm) {
        var b = el("button", "", pm[1]);
        b.type = "button";
        b.setAttribute("aria-pressed", r.perm === pm[0] ? "true" : "false");
        b.addEventListener("click", function () { r.perm = pm[0]; change(); });
        seg.appendChild(b);
      });
      line.appendChild(seg);
      var rm = el("button", "btn btn-ghost btn-icon", "\u00d7");
      rm.type = "button";
      rm.setAttribute("aria-label", "Remove scope");
      rm.disabled = rows.length === 1;
      rm.addEventListener("click", function () { rows.splice(i, 1); change(); });
      line.appendChild(rm);
      box.appendChild(line);
      var desc = el("div", "desc");
      if (valid(r)) {
        var chip = el("span", "scope");
        chip.appendChild(el("span", "scope-path", path(r)));
        chip.appendChild(el("span", "scope-perm p-" + r.perm, permLabel(r.perm)));
        desc.appendChild(chip);
      }
      desc.appendChild(el("span", "", describe(r)));
      if (valid(r) && (r.s === "*" || r.p === "*")) desc.appendChild(el("span", "badge " + (r.s === "*" ? "err" : "warn"), r.s === "*" ? "Whole vault, incl. future spaces" : "Includes future projects"));
      box.appendChild(desc);
      list.appendChild(box);
    });
    host.appendChild(list);
    var add = el("button", "btn btn-sm", "Add scope");
    add.type = "button";
    add.addEventListener("click", function () { rows.push({ s: "", p: "", sec: "*", perm: "read" }); change(); });
    host.appendChild(add);
  }

  function change() { render(); sync(); }

  // ---- summary aside ----
  function summary() {
    var box = document.getElementById("sum");
    if (!box) return;
    var pr = presetVal();
    var name = (document.getElementById("name").value || "").trim();
    var proj = (document.getElementById("project").value || "").trim();
    var items = [];
    var risk = "Scoped", rcls = "ok", wild = false;
    function add(perm, text) { items.push({ perm: perm, text: text }); }
    if (pr === "master") { add("write", "Read & write everything in the vault, including spaces created later."); risk = "Whole vault"; rcls = "err"; wild = true; }
    else if (pr === "master-ro") { add("read", "Read everything in the vault, including spaces created later."); risk = "Whole vault"; rcls = "err"; wild = true; }
    else if (pr === "agent") add("write", "Read & write agents/" + (name || "<name>") + " (its own agent space).");
    else if (pr === "project") { add("read", "Read the shared meta space."); add("write", "Read & write " + (proj || "<space/project>") + "."); }
    if (!unbounded(pr)) {
      rows.filter(valid).forEach(function (r) {
        add(r.perm, describe(r));
        if (r.s === "*") { risk = "Whole vault"; rcls = "err"; wild = true; }
        else if (r.p === "*" || r.sec === "*") { if (risk === "Scoped" && r.p === "*") { risk = "Broad"; rcls = "warn"; } wild = wild || r.p === "*" || r.sec === "*"; }
      });
    }
    box.textContent = "";
    var head = el("div", "row between");
    head.appendChild(el("h2", "", "Summary"));
    head.appendChild(el("span", "badge " + rcls, risk));
    box.appendChild(head);
    var who = el("div", "stack g4");
    who.appendChild(el("span", "hint", "Token"));
    who.appendChild(el("b", "", name || "Not named yet"));
    box.appendChild(who);
    var can = el("div", "stack");
    can.appendChild(el("span", "hint", "This token can"));
    if (!items.length) can.appendChild(el("span", "muted", "Nothing yet: pick an access template or add a scope."));
    items.forEach(function (it) {
      var r = el("div", "sum-can");
      r.appendChild(el("span", "permtag p-" + it.perm, permLabel(it.perm)));
      r.appendChild(el("span", "", it.text));
      can.appendChild(r);
    });
    box.appendChild(can);
    var pf = document.getElementById("project-field");
    if (pf) pf.hidden = pr !== "project";
    var exp = form.querySelector('input[name="expires_in_days"]:checked');
    var eb = document.getElementById("exp-hint");
    if (eb) eb.textContent = exp && exp.value ? "Stops working after " + exp.value + " days. You can always revoke it earlier." : "The token stays valid until you revoke it.";
    if (wild && exp && !exp.value) {
      var w = el("div", "note", "Broad access that never expires is the riskiest combination. 90 days is a good default.");
      box.appendChild(w);
    }
  }

  rows = parse(area.value);
  if (!rows.length) rows.push({ s: "", p: "", sec: "*", perm: "read" });
  area.addEventListener("input", function () {
    rows = parse(area.value);
    if (!rows.length) rows.push({ s: "", p: "", sec: "*", perm: "read" });
    render();
    summary();
  });
  form.addEventListener("change", function (e) {
    var t = e.target;
    if (t && (t.name === "preset" || t.name === "expires_in_days")) { render(); sync(); }
  });
  ["name", "project"].forEach(function (id) {
    var n = document.getElementById(id);
    if (n) n.addEventListener("input", summary);
  });
  var details = document.getElementById("lines-details");
  if (details) details.open = false;
  host.hidden = false;
  render();
  summary();
})();

// Push notifications: the service worker is registered on every page (keeps the subscription alive);
// the Access page section subscribes this device. Without support the form stays hidden with a hint.
(function () {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(function () {});
  var box = document.getElementById("push");
  var form = document.getElementById("push-form");
  var hint = document.getElementById("push-hint");
  if (!box || !form) return;
  // Notifications of requests that are no longer pending (decided, expired, handled elsewhere) are
  // removed here rather than by a silent push, which browsers penalise. The test one is left alone.
  function closeStale() {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    var pending = {};
    document.querySelectorAll('[id^="req-"]').forEach(function (n) { pending[n.id.slice(4)] = true; });
    navigator.serviceWorker.getRegistration().then(function (reg) {
      return reg ? reg.getNotifications() : [];
    }).then(function (list) {
      list.forEach(function (n) { if (/^[0-9a-f-]{36}$/.test(n.tag) && !pending[n.tag]) n.close(); });
    }).catch(function () {});
  }
  function say(t) { hint.textContent = t; hint.hidden = !t; }
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
    say("This browser cannot receive push notifications (needs HTTPS, a service worker and the Push API).");
    return;
  }
  if (Notification.permission === "denied") {
    say("Notifications are blocked for this site: allow them in the browser's site settings, then reload.");
    return;
  }
  closeStale();
  var ua = navigator.userAgent;
  var os = /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Windows/.test(ua) ? "Windows" : /Mac OS/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "Device";
  var br = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "browser";
  var label = document.getElementById("push-label");
  if (!label.value) label.value = os + " " + br;
  form.hidden = false;

  function b64urlToBytes(s) {
    var b = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
    var out = new Uint8Array(b.length);
    for (var i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
    return out;
  }
  function sameKey(sub, bytes) {
    var k = sub.options && sub.options.applicationServerKey;
    if (!k) return false;
    var a = new Uint8Array(k);
    if (a.length !== bytes.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i] !== bytes[i]) return false;
    return true;
  }
  var busy = false;
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    if (busy || !form.reportValidity()) return;
    busy = true;
    document.documentElement.setAttribute("data-enabling", "1");
    say("");
    var key = b64urlToBytes(box.getAttribute("data-vapid-key"));
    navigator.serviceWorker.register("/sw.js").then(function () { return navigator.serviceWorker.ready; })
      .then(function (reg) {
        return Notification.requestPermission().then(function (perm) {
          if (perm !== "granted") throw new Error("Permission was not granted.");
          return reg.pushManager.getSubscription();
        }).then(function (old) {
          // A subscription made under another server key cannot be reused.
          return old && !sameKey(old, key) ? old.unsubscribe().then(function () { return null; }) : old;
        }).then(function (old) {
          return old || reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
        });
      })
      .then(function (sub) {
        var j = sub.toJSON();
        form.elements.endpoint.value = j.endpoint;
        form.elements.p256dh.value = (j.keys && j.keys.p256dh) || "";
        form.elements.auth.value = (j.keys && j.keys.auth) || "";
        form.submit();
      })
      .catch(function (err) {
        busy = false;
        document.documentElement.removeAttribute("data-enabling");
        say("Could not enable notifications: " + (err && err.message ? err.message : "unknown error"));
      });
  });
})();

// Live access feed (SSE): keeps the Access badge current on every page and refreshes /access when
// requests change, unless a form there holds unsent input (then a reload banner is shown instead).
(function () {
  if (!window.EventSource) return;
  var body = document.body;
  var rendered = body.getAttribute("data-access-rev");
  if (rendered === null || rendered === "") return;
  var onAccess = location.pathname === "/access";
  var dirty = false;
  var leaving = false;
  var notice = null;
  var delay = 5000;
  if (onAccess) {
    document.addEventListener("input", function (e) {
      if (e.target && e.target.closest && e.target.closest("form")) dirty = true;
    });
    // Our own submit triggers an event too: let its redirect (and flash) win over a reload.
    document.addEventListener("submit", function (e) {
      if (!e.defaultPrevented) leaving = true;
    });
  }
  function badge(n) {
    var link = document.querySelector('.nav a[href="/access"]');
    if (!link || typeof n !== "number") return;
    var c = link.querySelector(".count");
    if (!n) { if (c) c.remove(); return; }
    if (!c) { c = document.createElement("span"); c.className = "count"; link.appendChild(c); }
    c.textContent = String(n);
    c.setAttribute("aria-label", n + " pending");
  }
  function showNotice() {
    if (notice) return;
    var wrap = document.querySelector(".main .wrap");
    if (!wrap) return;
    notice = document.createElement("div");
    notice.className = "banner warn live";
    notice.setAttribute("role", "status");
    var t = document.createElement("strong");
    t.textContent = "Access requests changed.";
    var b = document.createElement("button");
    b.type = "button";
    b.className = "btn btn-sm";
    b.textContent = "Reload";
    b.addEventListener("click", function () { location.reload(); });
    notice.appendChild(t);
    notice.appendChild(b);
    wrap.insertBefore(notice, wrap.firstChild);
  }
  function connect() {
    var es = new EventSource("/access/events");
    es.addEventListener("access", function (e) {
      delay = 5000;
      var d;
      try { d = JSON.parse(e.data); } catch (err) { return; }
      badge(d.pending);
      if (!onAccess || leaving || String(d.rev) === rendered) return;
      if (dirty || document.documentElement.hasAttribute("data-enabling")) showNotice(); else location.reload();
    });
    // A non-200 answer (redeploy, expired SSO session) closes the stream for good: retry with backoff.
    es.addEventListener("error", function () {
      if (es.readyState !== EventSource.CLOSED) return;
      setTimeout(connect, delay);
      delay = Math.min(delay * 2, 60000);
    });
  }
  connect();
})();
`;
