// Scores the LSP check from pi's session record and its stderr. Usage: assert.cjs <session-dir> <pi.out> <build>
const fs = require("fs");
/** @typedef {{ role?: string, toolName?: string, content?: Array<{ text?: string }>, details?: { build?: string } }} Message */
const [dir, outFile, build] = process.argv.slice(2);
const piOut = fs.readFileSync(outFile, "utf8");
const file = fs.readdirSync(dir).filter((/** @type {string} */ f) => f.endsWith(".jsonl")).map((/** @type {string} */ f) => `${dir}/${f}`)[0];
/** @type {Array<{ message?: Message }>} */
const entries = fs.readFileSync(file, "utf8").trim().split("\n").map((/** @type {string} */ l) => JSON.parse(l));
/** @type {Record<string, Array<{ text: string, build?: string }>>} */
const results = {};
for (const e of entries) {
  const m = e.message;
  if (m && m.role === "toolResult" && m.toolName) (results[m.toolName] ||= []).push({ text: (m.content || []).map((c) => c.text || "").join("\n"), build: m.details && m.details.build });
}
/** @type {Array<{ name: string, ok: boolean, detail: string }>} */
const checks = [];
/** @param {string} name @param {boolean} ok @param {unknown} detail */
const check = (name, ok, detail) => checks.push({ name, ok, detail: String(detail).slice(0, 150) });
const diag = results.lsp_diagnostics || [];
const text = (/** @type {number} */ i) => (diag[i] ? diag[i].text : "");
const first = (/** @type {string} */ s) => s.split("\n")[0];

// The plan: the files decide the servers.
check("plan: typescript, vue, json and bash started (their files exist)", ["typescript", "vue", "json", "bash"].every((l) => new RegExp(`\\[lsp\\] ${l}: running \\(\\d+ files\\)`).test(piOut)), (piOut.match(/\[lsp\][^\n]*/g) || []).join(" | "));
check("plan: no css, html or python server (no such files)", !/\[lsp\] (css|html|python)/.test(piOut), "");

// The rule: one server per language.
const probe = (results.bash || [])[0] ? results.bash[0].text : "";
/** @param {string} name */
const count = (name) => Number((new RegExp(`COUNT ${name} (\\d+)`).exec(probe) || [])[1]);
check("one typescript server (two projects, one process)", count("typescript-language-server") === 1, probe.split("\n").filter((l) => l.startsWith("COUNT")).join(" "));
check("one vue server", count("vue-language-server") === 1, "");
check("one json server", count("vscode-json-language-server") === 1, "");
check("one bash server", count("bash-language-server") === 1, "");
check("no css, html or python server", count("vscode-css-language-server") === 0 && count("vscode-html-language-server") === 0 && count("pyright-langserver") === 0, "");
check("tsserver runs with a heap ceiling", /HEAP max-old-space-size=1536/.test(probe), probe.split("\n").find((l) => l.startsWith("HEAP")) || "no HEAP line");

// The answers, by strategy: tsserver, tsserver + vue publish, tsserver in a second project, pull, push.
check("typescript: the planted type error (tsserver)", /src\/app\.ts:6:\d+ error: .*not assignable to type 'string'.*\[typescript 2322\]/.test(text(0)), first(text(0)));
check("vue: the template type error (tsserver + plugin)", /src\/App\.vue:6:\d+ error: Property 'missingThing' does not exist/.test(text(1)), first(text(1)));
check("second project keeps its own tsconfig: loose code is clean there", /^No diagnostics/.test(text(2)), first(text(2)));
check("json: a syntax error (pull diagnostics)", /bad\.json:\d+:\d+ error: /.test(text(3)), first(text(3)));
check("bash: an unquoted variable (versioned publish)", /run\.sh:\d+:\d+ \w+: .*\[shellcheck SC2086\]/.test(text(4)), first(text(4)));
check("after an edit, the same file is re-checked and clean", /^No diagnostics/.test(text(5)), first(text(5)));
check("external scratch file is rejected", /path must be inside the project/.test(text(6)), first(text(6)));
check("symlink to an external file is rejected", /path must be inside the project/.test(text(7)), first(text(7)));
check("Git-ignored script is rejected", /path is ignored by Git/.test(text(8)), first(text(8)));
check("dependency directory script is rejected", /path is excluded from language-server checks/.test(text(9)), first(text(9)));

// Navigation.
const def = (results.lsp_definition || [])[0];
check("lsp_definition points at the function declaration", !!def && /src\/app\.ts:1:17/.test(def.text), def ? def.text.trim() : "no result");
const hov = (results.lsp_hover || [])[0];
check("lsp_hover describes total", !!hov && /total/.test(hov.text) && /number/.test(hov.text), hov ? hov.text.trim().slice(0, 80) : "no result");

// The installed code is the repo's: every result carries the build the installer printed.
check("the tools ran the freshly installed build", diag.length === 10 && diag.slice(0, 6).every((d) => d.build === build), `${build} vs ${diag.map((d) => d.build).join(",")}`);

const bypass = (results.bash || [])[2];
check("a commit that skips the gate is blocked before it runs", !!bypass && /bypass the git gate/.test(bypass.text), bypass ? bypass.text.slice(0, 80) : "no result");
const last = entries.map((e) => e.message).filter(Boolean).filter((m) => m && m.role === "assistant").pop();
check("agent finished", !!last && /LSP_TEST_DONE/.test((last.content || []).map((c) => c.text || "").join("")), "");

for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"} ${c.name}  [${c.detail}]`);
console.log(checks.every((c) => c.ok) ? "LSP_FAUX_PASS" : "LSP_FAUX_FAIL");
process.exit(checks.every((c) => c.ok) ? 0 : 1);
