// Scores the custom-message check. Usage: trigger-assert.cjs <session-dir>
// pi records the trigger as a custom_message entry. The run it started is the first assistant answer after that entry,
// and it must carry the language-servers section the model was given.
const fs = require("fs");
const [dir] = process.argv.slice(2);
const file = fs.readdirSync(dir).filter((/** @type {string} */ f) => f.endsWith(".jsonl")).map((/** @type {string} */ f) => `${dir}/${f}`)[0];
/** @type {Array<{ type?: string, message?: { role?: string, content?: Array<{ text?: string }> } }>} */
const entries = fs.readFileSync(file, "utf8").trim().split("\n").map((/** @type {string} */ l) => JSON.parse(l));
const textOf = (/** @type {{ content?: Array<{ text?: string }> }} */ m) => (m.content || []).map((c) => c.text || "").join("\n");
const triggerAt = entries.findIndex((e) => e.type === "custom_message");
const answer = triggerAt < 0 ? undefined : entries.slice(triggerAt + 1).map((e) => e.message).find((m) => m && m.role === "assistant" && /LSP_TRIGGER_DONE/.test(textOf(m)));
/** @type {Array<{ name: string, ok: boolean, detail: string }>} */
const checks = [
  { name: "the custom message started a run", ok: triggerAt >= 0, detail: triggerAt >= 0 ? `entry ${triggerAt}` : "no custom_message entry in the session" },
  { name: "that run answered", ok: !!answer, detail: answer ? "answered" : "no answer after the custom message" },
  { name: "that run carries the language-servers section (typescript running)", ok: !!answer && /^- typescript: running \(\d+ files\)/m.test(textOf(answer)), detail: answer ? textOf(answer).split("\n").slice(1, 3).join(" | ") : "" },
];
for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"} ${c.name}  [${c.detail}]`);
process.exit(checks.every((c) => c.ok) ? 0 : 1);
