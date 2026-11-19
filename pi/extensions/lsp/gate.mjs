#!/usr/bin/env node
// The git gate. A commit is rejected when any server reports an error, a warning or information: the standard is perfect,
// so nothing a server flags may be committed. Hints are suggestions: shown, not blocking. Fails closed: a server that is
// missing, or that does not answer, blocks the commit.
//
//   node gate.mjs               staged (what the pre-commit hook runs): the staged content of each changed file
//   node gate.mjs all           every file of every language in the repo (what `just check` runs)
//   node gate.mjs files <path>  the working copy of the given files
//
// TypeScript is checked project-wide: a change to one file can break its callers, so every TypeScript file under the
// affected tsconfig is checked, with staged text overlaid for the files being committed.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { LANGUAGES, SEVERITY, checkDocuments, startServer, listFiles, killAllLiveServers } from "./core.mjs";

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
// Fixtures that are not standalone code (overlays, composed at runtime). Listed with reasons in gate-exclude.txt.
/** @type {string[]} */
const EXCLUDE = (() => {
  try {
    return readFileSync(join(root, "pi/lsp/gate-exclude.txt"), "utf8").split("\n").map((l) => l.replace(/#.*/, "").trim()).filter(Boolean);
  } catch {
    return [];
  }
})();
/** @param {string} abs */
const excluded = (abs) => EXCLUDE.some((prefix) => rel(abs).startsWith(prefix));

/** Files to check, and the text to check for each. */
/** @type {Map<string, string>} */
const staged = new Map();
/** @type {string[] | null} */
let files = null;
if (mode === "staged") {
  const names = git(["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"]).split("\0").filter(Boolean);
  for (const name of names) {
    const abs = join(root, name);
    staged.set(abs, gitBytes(["show", `:${name}`]).toString("utf8"));
  }
  files = [...staged.keys()];
} else if (mode === "files") {
  files = process.argv.slice(3).map((p) => resolve(root, p));
} else if (mode === "all") {
  files = null;
} else {
  console.error("usage: gate.mjs [staged|all|files <paths>]");
  process.exit(2);
}
/** @param {string} abs */
const textFor = (abs) => staged.get(abs) ?? readFileSync(abs, "utf8");

/** Nearest directory above a file that holds a tsconfig or jsconfig, or null: a file with no project is a finding. @param {string} abs @returns {string | null} */
function projectOf(abs) {
  let dir = dirname(abs);
  while (dir.startsWith(root)) {
    if (existsSync(join(dir, "tsconfig.json")) || existsSync(join(dir, "jsconfig.json"))) return dir;
    if (dir === root) break;
    dir = dirname(dir);
  }
  return null;
}

/** A group is one server run: a language, and the server root it starts at. */
/** @type {Map<string, { lang: LangId, serverRoot: string, files: Set<string> }>} */
const groups = new Map();
/** @param {LangId} lang @param {string} serverRoot @param {string} file */
const addTo = (lang, serverRoot, file) => {
  if (excluded(file)) return;
  const key = `${lang}\0${serverRoot}`;
  if (!groups.has(key)) groups.set(key, { lang, serverRoot, files: new Set() });
  groups.get(key)?.files.add(file);
};
/** @type {LangId[]} */
const LANG_IDS = /** @type {LangId[]} */ (Object.keys(LANGUAGES));
for (const lang of LANG_IDS) {
  if (mode === "all") {
    for (const f of LANGUAGES[lang].files(root)) {
      if (LANGUAGES[lang].perFile) addTo(lang, f, f);
      else if (lang !== "typescript") addTo(lang, root, f);
      else addTo(lang, projectOf(f) ?? "", f);
    }
    continue;
  }
  const mine = (files ?? []).filter((f) => LANGUAGES[lang].languageId(f) !== undefined);
  if (mine.length === 0) continue;
  if (lang === "typescript") {
    // Every TypeScript file under each affected project, so breakage in callers is caught.
    for (const f of mine) {
      const p = projectOf(f);
      if (p === null) continue;
      for (const g of listFiles(p, (n) => LANGUAGES.typescript.languageId(n) !== undefined)) addTo(lang, p, g);
    }
  } else {
    for (const f of mine) addTo(lang, LANGUAGES[lang].perFile ? f : root, f);
  }
}

/** @type {string[]} */
const failures = [];
// A TypeScript or JavaScript file that no tsconfig or jsconfig covers has no project: the standard requires one.
for (const [key, g] of groups) {
  if (key.startsWith("typescript\0") && g.serverRoot === "") {
    for (const f of g.files) failures.push(`${rel(f)}: no tsconfig.json or jsconfig.json covers this file; add one to the folder that owns it`);
    groups.delete(key);
  }
}
/** @type {string[]} */
const notes = [];
let checkedFiles = 0;
let errors = 0;
let warnings = 0;
let infos = 0;

if (groups.size === 0) {
  console.log(`gate: nothing to check (${mode})`);
  process.exit(0);
}

const JOBS = Math.max(1, Number(process.env.DPI_GATE_JOBS ?? 3));
/** Runs fn over items, at most n at a time. @template T, R @param {T[]} items @param {number} n @param {(item: T) => Promise<R>} fn @returns {Promise<R[]>} */
async function pool(items, n, fn) {
  /** @type {R[]} */
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

/**
 * @typedef {{ label: string, fatal: string } | { label: string, server: import("./core.mjs").Running, outcomes: Map<string, import("./core.mjs").Diagnostic[] | Error>, info: string }} GroupResult
 */
/** @type {GroupResult[]} */
const results = await pool(
  [...groups.values()],
  JOBS,
  async (g) => {
    const label = `${LANGUAGES[g.lang].label}${g.lang === "typescript" ? ` (${rel(g.serverRoot) || "."})` : ""}`;
    /** @type {Awaited<ReturnType<typeof startServer>>} */
    let server;
    try {
      server = await startServer(g.lang, LANGUAGES[g.lang].perFile ? root : g.serverRoot);
    } catch (e) {
      return { label, fatal: `server did not start: ${/** @type {Error} */ (e).message}` };
    }
    if (!("client" in server)) return { label, fatal: server.missing };
    const list = [...g.files];
    const t0 = Date.now();
    const outcomes = await checkDocuments(server, list, textFor, 15_000);
    if (process.env.DPI_GATE_DEBUG) console.error(`[gate-debug] ${label}: ${list.length} files in ${Date.now() - t0} ms, unanswered ${[...outcomes.values()].filter((v) => !Array.isArray(v)).length}`);
    return { label, server, outcomes, info: server.info };
  },
);

for (const r of results) {
  if ("fatal" in r) {
    failures.push(`${r.label}: ${r.fatal}`);
    continue;
  }
  notes.push(`${r.label}: ${r.info}, ${r.outcomes.size} file(s)`);
  for (const [file, diags] of r.outcomes) {
    checkedFiles += 1;
    if (!Array.isArray(diags)) {
      failures.push(`${rel(file)}: could not be checked (${diags.message})`);
      continue;
    }
    for (const d of diags) {
      const sev = d.severity ?? 1;
      const where = `${rel(file)}:${d.range.start.line + 1}:${d.range.start.character + 1}`;
      const code = d.code !== undefined ? ` [${d.source ?? r.label.split(" ")[0].toLowerCase()} ${d.code}]` : "";
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
  await r.server.client.shutdown();
}

const seconds = ((Date.now() - started) / 1000).toFixed(1);
for (const n of notes) console.log(n.startsWith("  ") ? n : `gate: ${n}`);
if (failures.length === 0) {
  console.log(`gate: PASS, ${checkedFiles} file(s), nothing flagged (${seconds} s)`);
  killAllLiveServers();
  process.exit(0);
}
for (const f of failures) console.log(`FAIL ${f}`);
const checkProblems = failures.length - errors - warnings - infos;
console.log(`gate: FAIL, ${errors} error(s), ${warnings} warning(s), ${infos} information(s), ${checkProblems} problem(s) with the checks, in ${checkedFiles} file(s) (${seconds} s).`);
console.log("gate: fix these, stage the fixes, and commit again. `just lsp check` shows the whole project.");
killAllLiveServers();
process.exit(1);
