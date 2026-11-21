import { test } from "node:test";
import assert from "node:assert/strict";
import { isSha, parseLog, updateNotice } from "../src/update-notice.js";

const A = "a".repeat(40);
const B = "b".repeat(40);

test("the log parser keeps sha and subject, and skips anything else", () => {
  const out = `${A}\tfirst change\n\nnot a commit line\n${B}\tsecond\twith tab\n`;
  assert.deepEqual(parseLog(out), [
    { sha: A, subject: "first change" },
    { sha: B, subject: "second\twith tab" },
  ]);
});

test("the notice names the changes, links to the changelog, and stays short", () => {
  const commits = [1, 2, 3, 4, 5].map((n) => ({ sha: String(n).repeat(40), subject: `change ${n} ${"x".repeat(80)}` }));
  const notice = updateNotice("durable-pi", commits, A, B);
  assert.equal(notice.title, "durable-pi update made");
  assert.match(notice.body, /^5 changes: change 1/);
  assert.match(notice.body, /and 2 more$/);
  assert.ok(notice.body.length <= 180);
  assert.equal(notice.url, `/?changelog=${B}&from=${A}`);
});

test("a single change is singular, and a missing previous sha is left out of the link", () => {
  const notice = updateNotice("durable-pi", [{ sha: B, subject: "only" }], "", B);
  assert.equal(notice.body, "1 change: only");
  assert.equal(notice.url, `/?changelog=${B}`);
  assert.equal(updateNotice("durable-pi", [], "", B).body, "Update made");
});

test("only hex shas are accepted", () => {
  assert.equal(isSha("abc1234"), true);
  assert.equal(isSha("../etc"), false);
  assert.equal(isSha("HEAD"), false);
});
