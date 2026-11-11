import { test } from "node:test";
import assert from "node:assert/strict";
import { esc, html, raw } from "./html";

const PAYLOADS = [
  `<script>alert(1)</script>`,
  `"><img src=x onerror=alert(1)>`,
  `' onmouseover='alert(1)`,
  `</textarea><svg/onload=alert(1)>`,
  `&lt;already&gt;`,
];

test("html`` escapes every interpolated value", () => {
  for (const p of PAYLOADS) {
    const out = html`<p title="${p}">${p}</p>`.value;
    assert.equal(out, `<p title="${esc(p)}">${esc(p)}</p>`);
    assert.doesNotMatch(out, /<(script|img|svg)/);
    assert.equal(out.split('"').length, 3, "no quote can break out of the attribute");
  }
  assert.equal(html`${"&"}`.value, "&amp;");
});

test("html`` escapes inside arrays, numbers and nested templates", () => {
  const out = html`<ul>${PAYLOADS.map((p) => html`<li>${p}</li>`)}</ul>${5}`.value;
  assert.doesNotMatch(out, /<script|<img src|<svg/);
  assert.match(out, /5$/);
  // A nested html`` result is NOT double-escaped, its own values were escaped once.
  assert.equal(html`${html`<b>${"<"}</b>`}`.value, "<b>&lt;</b>");
});

test("only raw() bypasses escaping; null/false render nothing", () => {
  assert.equal(html`${raw("<b>x</b>")}`.value, "<b>x</b>");
  assert.equal(html`[${null}${undefined}${false}]`.value, "[]");
  assert.equal(html`${"<b>"}`.value, "&lt;b&gt;");
});
