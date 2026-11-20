import { test } from "node:test";
import assert from "node:assert/strict";
import { readOnlyRefusal } from "../src/read-only.js";

test("reads and listings run", () => {
  for (const c of ["ls -la", "cat index.html", "head -n 20 src/app.ts", "grep -rn 'start' .", "find . -name '*.ts'", "git status", "git log --oneline -5", "wc -l index.html", "echo hello"]) {
    assert.equal(readOnlyRefusal(c), undefined, c);
  }
});

test("anything that writes, chains, redirects or substitutes is refused", () => {
  for (const c of ["cat <<EOF > index.html", "echo x > a.txt", "ls && rm -rf x", "ls; rm a", "cat a | sh", "echo $(rm a)", "echo `rm a`", "cat ${HOME}/x", "ls\nrm a"]) {
    assert.notEqual(readOnlyRefusal(c), undefined, c);
  }
});

test("programs that can write or run commands are not on the list", () => {
  for (const c of ["rm index.html", "cp a b", "mv a b", "npm install", "sed -i 's/a/b/' x", "awk '{print}' x", "tee out", "touch x", "rg --pre sh x", "sort -o out in"]) {
    assert.notEqual(readOnlyRefusal(c), undefined, c);
  }
});

test("git and find flags that write are refused", () => {
  assert.notEqual(readOnlyRefusal("git commit -m x"), undefined);
  assert.notEqual(readOnlyRefusal("git checkout ."), undefined);
  assert.notEqual(readOnlyRefusal("find . -exec rm {} ;"), undefined);
  assert.notEqual(readOnlyRefusal("find . -delete"), undefined);
});

test("a refused command comes back as an error result the model can read, and nothing runs", async () => {
  const { readOnlyBashTool } = await import("../src/read-only.js");
  const tool = readOnlyBashTool();
  const result = await tool.execute({ command: "cat <<EOF > index.html" }, {} as never, {} as never);
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result.output), /read-only shell refused/);
});
