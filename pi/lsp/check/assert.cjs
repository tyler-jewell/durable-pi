const fs = require("fs");
const dir = process.argv[2];
const file = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => `${dir}/${f}`)[0];
const entries = fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const results = {};
for (const e of entries) {
  const m = e.message;
  if (m && m.role === "toolResult") (results[m.toolName] ||= []).push((m.content || []).map((c) => c.text || "").join("\n"));
}
const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok, detail: String(detail).slice(0, 160) });
const probe = (results.bash || [])[0] || "";
check("language server running during the session", /RUNNING server pid=\d+/.test(probe), probe.split("\n").find((l) => l.includes("server")) || "no server line");
check("its tsserver child running during the session", /RUNNING tsserver pid=\d+/.test(probe), probe.split("\n").find((l) => l.includes("tsserver")) || "no tsserver line");
const diag = (results.lsp_diagnostics || [])[0] || "";
check("lsp_diagnostics reports the planted type error", /src\/app\.ts:6:\d+ error: .*not assignable to type 'string'/.test(diag), diag.split("\n")[0]);
check("lsp_diagnostics code is typescript 2322", /\[typescript 2322\]/.test(diag), diag.split("\n")[0]);
const def = (results.lsp_definition || [])[0] || "";
check("lsp_definition points at the function declaration", /src\/app\.ts:1:17/.test(def), def.trim());
const hov = (results.lsp_hover || [])[0] || "";
check("lsp_hover describes total", /total/.test(hov) && /number/.test(hov), hov.trim().slice(0, 120));
const bypass = (results.bash || [])[1] || "";
check("a commit that skips the gate is blocked before it runs", /skip the git gate/.test(bypass), bypass.slice(0, 100));
const last = entries.map((e) => e.message).filter(Boolean).filter((m) => m.role === "assistant").pop();
const final = (last?.content || []).map((c) => c.text || "").join("");
check("agent finished", /LSP_TEST_DONE/.test(final), final.slice(0, 60));
for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"} ${c.name}  [${c.detail}]`);
console.log(checks.every((c) => c.ok) ? "LSP_FAUX_PASS" : "LSP_FAUX_FAIL");
process.exit(checks.every((c) => c.ok) ? 0 : 1);
