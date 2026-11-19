#!/usr/bin/env node
// The git gate. A commit is rejected when any server reports an error, a warning or information: the standard is perfect,
// so nothing a server flags may be committed. Hints are suggestions: shown, not blocking. Fails closed: a server that is
// missing, or that does not answer, blocks the commit.
//
//   node gate.mjs               staged (what the pre-commit hook runs): the staged content of each changed file
//   node gate.mjs all           every file of every language in the repo (what `just lsp check` runs)
//   node gate.mjs files <path>  the working copy of the given files
//   node gate.mjs plan          the file extensions in the repo, and the servers they call for (starts nothing)
//
// The servers are the core's: one per language. A change to one TypeScript file can break its callers, so every
// TypeScript and Vue file under the affected tsconfig is checked, with the staged text overlaid for the files committed.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { LANGUAGES, SEVERITY, Workspace, describeScan, excludedPaths, killAllLiveServers, langOf, planLanguages, projectOf, scanWorkspace } from "./core.mjs";

/** @typedef {import("./core.mjs").LangId} LangId */

const started = Date.now();
const mode = process.argv[2] ?? "staged";
/** @param {string[]} args */
const git = (args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 256 << 20 });
/** @param {string[]} args */
const gitBytes = (args) => execFileSync("git", args, { maxBuffer: 256 << 20 });
const root = git(["rev-parse", "--show-toplevel"]).trim();
/** @param {string} abs */
const rel = (abs) => relative(root, abs) || abs;
// Paths the gate does not check, with reasons, in gate-exclude.txt.
const EXCLUDE = excludedPaths(root);
/** @param {string} abs */
const excluded = (abs) => EXCLUDE.some((prefix) => rel(abs).startsWith(prefix));

if (mode === "plan") {
  const scan = scanWorkspace(root, EXCLUDE);
  console.log(`${scan.files.length} file(s) in ${root}`);
  for (const line of describeScan(scan)) console.log(`  ${line}`);
  const langs = planLanguages(scan);
  console.log(`servers: ${langs.length ? langs.map((l) => `${l} (${scan.byLang.get(l)?.length ?? 0} files)`).join(", ") : "none"}`);
  process.exit(0);
}

/** Files to check, and the staged text for each (the working copy otherwise). */
/** @type {Map<string, string>} */
const staged = new Map();
/** @type {string[]} */
let candidates;
if (mode === "staged") {
  const names = git(["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"]).split("\0").filter(Boolean);
  for (const name of names) staged.set(join(root, name), gitBytes(["show", `:${name}`]).toString("utf8"));
  candidates = [...staged.keys()];
} else if (mode === "files") {
  candidates = process.argv.slice(3).map((p) => resolve(root, p));
} else if (mode === "all") {
  candidates = scanWorkspace(root, EXCLUDE).files;
} else {
  console.error("usage: gate.mjs [staged|all|files <paths>|plan]");
  process.exit(2);
}
/** @param {string} abs */
const textFor = (abs) => staged.get(abs) ?? readFileSync(abs, "utf8");

/** @type {Set<string>} */
const files = new Set(candidates.filter((f) => langOf(f) && !excluded(f)));
if (mode !== "all") {
  // Every TypeScript and Vue file under each affected project, so breakage in callers is caught.
  const everything = scanWorkspace(root, EXCLUDE).byLang;
  const projects = new Set();
  for (const f of files) {
    const lang = langOf(f);
    const p = lang === "typescript" || lang === "vue" ? projectOf(root, f) : undefined;
    if (p) projects.add(p);
  }
  for (const lang of /** @type {LangId[]} */ (["typescript", "vue"])) {
    for (const f of everything.get(lang) ?? []) if ([...projects].some((p) => f.startsWith(`${p}/`))) files.add(f);
  }
}

if (files.size === 0) {
  console.log(`gate: nothing to check (${mode})`);
  process.exit(0);
}

const wanted = /** @type {LangId[]} */ ([...new Set([...files].map((f) => /** @type {LangId} */ (langOf(f))))]);
const ws = new Workspace(root, { exclude: EXCLUDE });
await ws.start(wanted);
const outcomes = await ws.diagnostics([...files], { textFor });
if (process.env.DPI_GATE_DEBUG) console.error(`[gate-debug] servers ${JSON.stringify(ws.serverCounts())} in ${Date.now() - started} ms`);

/** @type {string[]} */
const failures = [];
/** @type {string[]} */
const notes = [];
let errors = 0;
let warnings = 0;
let infos = 0;

// A language whose server did not start fails every one of its files.
for (const s of ws.status()) if (s.state === "failed") failures.push(`${s.label}: ${s.message}`);
for (const s of ws.status()) if (s.state === "running") notes.push(`gate: ${s.label}: ${[...files].filter((f) => langOf(f) === s.lang).length} file(s)`);

for (const [file, diags] of outcomes) {
  const lang = /** @type {LangId} */ (langOf(file));
  if (!Array.isArray(diags)) {
    // A file of a language that failed to start is already reported once, as the language.
    if (ws.status().find((s) => s.lang === lang)?.state !== "failed") failures.push(`${rel(file)}: could not be checked (${diags.message})`);
    continue;
  }
  for (const d of diags) {
    const sev = d.severity ?? 1;
    const where = `${rel(file)}:${d.range.start.line + 1}:${d.range.start.character + 1}`;
    const code = d.code !== undefined ? ` [${d.source ?? LANGUAGES[lang].label} ${d.code}]` : "";
    const line = `${where} ${SEVERITY[sev - 1] ?? "error"}: ${d.message}${code}`;
    if (sev === 1) {
      errors += 1;
      failures.push(line);
    } else if (sev === 2) {
      warnings += 1;
      failures.push(line);
    } else if (sev === 3) {
      infos += 1;
      failures.push(line);
    } else {
      notes.push(`  hint ${line}`);
    }
  }
}
await ws.shutdown();

const seconds = ((Date.now() - started) / 1000).toFixed(1);
for (const n of notes) console.log(n);
if (failures.length === 0) {
  console.log(`gate: PASS, ${outcomes.size} file(s), nothing flagged (${seconds} s)`);
  killAllLiveServers();
  process.exit(0);
}
for (const f of failures) console.log(`FAIL ${f}`);
const checkProblems = failures.length - errors - warnings - infos;
console.log(`gate: FAIL, ${errors} error(s), ${warnings} warning(s), ${infos} information(s), ${checkProblems} problem(s) with the checks, in ${outcomes.size} file(s) (${seconds} s).`);
console.log("gate: fix these, stage the fixes, and commit again. `just lsp check` shows the whole project.");
killAllLiveServers();
process.exit(1);
