// Scores one eval run from pi's session record and the repo the agent left. Prints PASS/FAIL lines and one EVAL_RESULT line.
// Usage: score.cjs <session-dir> <case.json> <repo> <gate.mjs> <pi-exit> <setup-ms> <agent-ms>
const fs = require("fs");
const { execFileSync } = require("child_process");
const [sessionDir, caseFile, repo, gate, piExit, setupMs, agentMs] = process.argv.slice(2);
/** @type {{ lsp: string, vue?: boolean, files: Array<{ path: string, must?: string[], mustNot?: string[] }> }} */
const spec = JSON.parse(fs.readFileSync(caseFile, "utf8"));

/** @typedef {{ role?: string, toolName?: string, isError?: boolean, content?: Array<{ type?: string, name?: string, text?: string, arguments?: Record<string, unknown> }>, usage?: { totalTokens?: number, cost?: { total?: number } } }} Message */
const file = fs.readdirSync(sessionDir).filter((/** @type {string} */ f) => f.endsWith(".jsonl")).map((/** @type {string} */ f) => `${sessionDir}/${f}`)[0];
/** @type {Message[]} */
const messages = fs.readFileSync(file, "utf8").trim().split("\n").map((/** @type {string} */ l) => JSON.parse(l).message).filter(Boolean);
/** @type {Array<{ name: string, args: Record<string, unknown> }>} */
const calls = [];
let tokens = 0;
let cost = 0;
let turns = 0;
for (const m of messages) {
  if (m.role === "assistant") {
    turns += 1;
    tokens += (m.usage && m.usage.totalTokens) || 0;
    cost += (m.usage && m.usage.cost && m.usage.cost.total) || 0;
    for (const c of m.content || []) if (c.type === "toolCall" && c.name) calls.push({ name: c.name, args: c.arguments || {} });
  }
}
const lsp = calls.filter((c) => c.name.startsWith("lsp_"));
const lspPath = new RegExp(spec.lsp);
// A project-wide diagnostics call (no path) covers every file; otherwise the path must be one the task is about.
const relevant = lsp.filter((c) => c.args.path === undefined || lspPath.test(String(c.args.path)));
let lastEdit = -1;
let firstLspAfterEdit = -1;
calls.forEach((c, i) => {
  if (c.name === "edit" || c.name === "write") lastEdit = i;
});
calls.forEach((c, i) => {
  if (firstLspAfterEdit < 0 && i > lastEdit && lastEdit >= 0 && c.name === "lsp_diagnostics") firstLspAfterEdit = i;
});

/** @type {Array<{ name: string, ok: boolean, detail: string }>} */
const checks = [];
/** @param {string} name @param {boolean} ok @param {unknown} detail */
const check = (name, ok, detail) => checks.push({ name, ok, detail: String(detail).slice(0, 200) });

check("the agent finished", Number(piExit) === 0, `pi exit ${piExit}`);
check("the agent used a language server tool on the files the task is about", relevant.length > 0, `lsp calls: ${lsp.map((c) => `${c.name}(${c.args.path ?? "project"})`).join(", ") || "none"}`);
check("the agent checked its edits with lsp_diagnostics after the last edit", firstLspAfterEdit >= 0, lastEdit < 0 ? "no edit made" : `last edit at call ${lastEdit}, diagnostics at ${firstLspAfterEdit}`);
for (const f of spec.files) {
  const text = fs.existsSync(`${repo}/${f.path}`) ? fs.readFileSync(`${repo}/${f.path}`, "utf8") : "";
  for (const re of f.must || []) check(`${f.path} has /${re}/`, new RegExp(re).test(text), "");
  for (const re of f.mustNot || []) check(`${f.path} has no /${re}/`, !new RegExp(re).test(text), "");
}
const g0 = Date.now();
let gateOut = "";
let gateOk = false;
try {
  gateOut = execFileSync("node", [gate, "all"], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  gateOk = true;
} catch (/** @type {any} */ e) {
  gateOut = `${e.stdout || ""}${e.stderr || ""}`;
}
const gateMs = Date.now() - g0;
check("the repo passes the gate (every file clean)", gateOk, gateOut.split("\n").filter((l) => l.startsWith("FAIL")).slice(0, 2).join(" | ") || gateOut.trim().split("\n").pop());

const hard = checks.filter((c) => !c.name.startsWith("the agent checked its edits"));
const pass = hard.every((c) => c.ok);
for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"} ${c.name}${c.detail ? `  [${c.detail}]` : ""}`);
console.log(`EVAL_RESULT ${JSON.stringify({ pass, verified: firstLspAfterEdit >= 0, lspCalls: lsp.length, turns, tokens, costUsd: Number(cost.toFixed(5)), setupMs: Number(setupMs), agentMs: Number(agentMs), gateMs, tools: calls.map((c) => c.name).join(",") })}`);
process.exit(pass ? 0 : 1);
