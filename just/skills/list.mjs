// Print every installed skill with its source, pinned version and agents.
// Upstream skills: the commit pinned in skills-lock.json. Repo-owned skills (not in the lock):
// the last commit that changed their folder.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const cli = "skills@1.9.0";

const lock = JSON.parse(readFileSync(`${root}skills-lock.json`, "utf8")).skills;
const installed = JSON.parse(
  execFileSync("npx", ["-y", cli, "list", "--json"], { cwd: root, encoding: "utf8" }),
);

/** @param {string[]} args */
const git = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

/** @typedef {{ name: string, source: string, version: string, kind: string, agents: string }} Row */
/** @type {Row[]} */
const rows = installed.map(/** @param {{ name: string, agents: string[] }} skill */ (skill) => {
  const pin = lock[skill.name];
  if (pin) {
    return {
      name: skill.name,
      source: pin.source,
      version: pin.commit.slice(0, 7),
      kind: "upstream",
      agents: skill.agents.join(", "),
    };
  }
  const last = git(["log", "-1", "--format=%h %ad", "--date=short", "--", `.agents/skills/${skill.name}`]);
  const [version = "untracked", date = ""] = last.split(" ");
  return {
    name: skill.name,
    source: "this repo",
    version: last ? `${version} ${date}` : "untracked",
    kind: "repo",
    agents: skill.agents.join(", "),
  };
});

/** @param {string} key */
const width = (key) => Math.max(key.length, ...rows.map((r) => String(r[/** @type {keyof Row} */ (key)]).length));
const cols = /** @type {(keyof Row)[]} */ (["name", "source", "version", "kind", "agents"]);
const widths = Object.fromEntries(cols.map((c) => [c, width(c)]));
/** @param {Row} r */
const line = (r) => cols.map((c, i) => (i === cols.length - 1 ? String(r[c]) : String(r[c]).padEnd(widths[c]))).join("  ");

console.log(line(/** @type {Row} */ (Object.fromEntries(cols.map((c) => [c, c.toUpperCase()])))));
for (const r of rows.sort((a, b) => a.name.localeCompare(b.name))) console.log(line(r));
console.log(`\n${rows.length} skills (${rows.filter((r) => r.kind === "upstream").length} pinned upstream, ${rows.filter((r) => r.kind.startsWith("repo")).length} repo-owned)`);
