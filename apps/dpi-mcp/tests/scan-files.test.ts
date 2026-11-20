import { test } from "node:test";
import assert from "node:assert/strict";
import { scanFiles, selectFiles } from "../src/scan-files.js";

const files = ["src/app.ts", "src/skip.ts", "docs/readme.md"];

test("include and exclude select tracked files, and an empty match returns nothing", () => {
  assert.deepEqual(selectFiles(files, ["src/*.ts"], ["src/skip.ts"]), ["src/app.ts"]);
  assert.deepEqual(selectFiles(files, ["no-such/*"]), []);
});

test("each selected file is judged once, and an unjudged file is an error", async () => {
  const calls: string[] = [];
  const scanned = await scanFiles(["src/app.ts", "src/bad.ts"], async (path) => {
    calls.push(path);
    if (path.endsWith("bad.ts")) throw new Error("no decision");
    return { answer: "yes", confidence: 0.9, probabilities: { yes: 0.9, no: 0.1 }, tool: "decision-tool" };
  });
  assert.deepEqual(calls, ["src/app.ts", "src/bad.ts"]);
  assert.equal(scanned.results.length, 1);
  assert.equal(scanned.results[0]?.tool, "decision-tool");
  assert.deepEqual(scanned.errors, [{ path: "src/bad.ts", error: "no decision" }]);
});
