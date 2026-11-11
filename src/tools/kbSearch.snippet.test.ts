import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_LINE_CHARS, snippet } from "./snippet";

test("short lines are returned trimmed", () => {
  assert.equal(snippet("  hello needle  ", "needle"), "hello needle");
});

test("window contains the match and marks both cuts", () => {
  const s = snippet(`${"a".repeat(500)}needle${"b".repeat(500)}`, "needle");
  assert.ok(s.includes("needle"));
  assert.ok(s.startsWith("…") && s.endsWith("…"));
  assert.ok(Array.from(s).length <= MAX_LINE_CHARS + 2);
});

test("match at the start / end only gets one ellipsis", () => {
  const head = snippet(`needle${"b".repeat(500)}`, "needle");
  assert.ok(head.startsWith("needle") && head.endsWith("…"));
  const tail = snippet(`${"a".repeat(500)}needle`, "needle");
  assert.ok(tail.startsWith("…") && tail.endsWith("needle"));
});

test("never splits a surrogate pair", () => {
  const line = "😀".repeat(300) + "needle" + "😀".repeat(300);
  const s = snippet(line, "needle");
  assert.ok(s.includes("needle"));
  assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(s));
});
