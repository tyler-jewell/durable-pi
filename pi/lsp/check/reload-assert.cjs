// Scores the reload check. Usage: reload-assert.cjs <session-dir> <build-before> <build-after>
// The tool results carry the build that produced them. Before the reload it is the first install; after it, the swapped one.
const fs = require("fs");
const [dir, before, after] = process.argv.slice(2);
const file = fs.readdirSync(dir).filter((/** @type {string} */ f) => f.endsWith(".jsonl")).map((/** @type {string} */ f) => `${dir}/${f}`)[0];
/** @type {Array<{ message?: { role?: string, toolName?: string, isError?: boolean, content?: Array<{ text?: string }>, details?: { build?: string } } }>} */
const entries = fs.readFileSync(file, "utf8").trim().split("\n").map((/** @type {string} */ l) => JSON.parse(l));
const diag = entries.map((e) => e.message).filter((m) => m && m.role === "toolResult" && m.toolName === "lsp_diagnostics");
const text = (/** @type {number} */ i) => ((diag[i] && diag[i].content) || []).map((c) => c.text || "").join("");
const build = (/** @type {number} */ i) => (diag[i] && diag[i].details ? diag[i].details.build : undefined);
/** @type {Array<{ name: string, ok: boolean, detail: string }>} */
const checks = [
  { name: "before the reload the first build answers", ok: build(0) === before, detail: `build ${build(0)}` },
  { name: "the first build's answer is right", ok: /2322/.test(text(0)), detail: text(0).split("\n")[0] },
  { name: "after the reload the swapped build answers", ok: build(1) === after, detail: `build ${build(1)} (want ${after})` },
  { name: "the swapped build's answer is right", ok: /2322/.test(text(1)), detail: text(1).split("\n")[0].slice(0, 100) },
];
for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"} ${c.name}  [${c.detail}]`);
process.exit(checks.every((c) => c.ok) ? 0 : 1);
