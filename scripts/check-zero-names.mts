// The zero-names ratchet: the repo holds no model names. Nothing here is a model list. The names to look for
// come from this machine's tool store (local hosts and the cloud catalog), so the repo never has to
// contain them, and the baseline stores only file paths and counts.
//
//   npx tsx scripts/check-zero-names.mts            # fail if any file has more names than its baseline
//   npx tsx scripts/check-zero-names.mts --update   # lower the baseline to today's counts (never raises it)
//
// The baseline shrinks as names are removed. A new file with names fails at once.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BASELINE = "scripts/zero-names-baseline.json";
const TOOL_STORE = process.env.DPI_MCP_TOOLS ?? join(homedir(), ".dpi-mcp", "tools.json");
const MIN_NAME = 4;

/** Model-identifier patterns that need no discovery: a cloud catalog namespace and a quantization suffix. */
const PATTERNS: RegExp[] = [/@cf\//, /-Q[2-8]_[A-Z0-9_]+/, /MXFP4/];

/** Names from the tool store: the model id, the tool name and the family of every tool. */
export function discoveredNames(storePath = TOOL_STORE): string[] {
  if (!existsSync(storePath)) {
    console.warn(`zero-names: no tool store at ${storePath}; checking the patterns only (run discovery for the full check)`);
    return [];
  }
  const store = JSON.parse(readFileSync(storePath, "utf8")) as { tools?: { model?: string; name?: string; family?: string }[] };
  const names = new Set<string>();
  for (const c of store.tools ?? []) {
    for (const v of [c.model, c.name, c.family]) if (v && v.length >= MIN_NAME) names.add(v);
  }
  return [...names].sort((a, b) => b.length - a.length); // longest first, so "Foo-Bar" wins over "Foo"
}

/** Files that carry no opinion of ours: lockfiles, vendored third-party skills, the baseline, this guard, and the one
 *  test helper that spells a naming convention for the parser tests (see tests/naming-fixtures.ts). */
export function isExcluded(path: string): boolean {
  return path.endsWith("package-lock.json") || path.startsWith(".agents/") || path.startsWith(".claude/skills/") || path === BASELINE || path === "scripts/check-zero-names.mts" || path === "apps/dpi-mcp/tests/naming-fixtures.ts";
}

/** Count matches per file. Returns path → { count, examples } with the matched text, for fixing. */
export function countNames(files: string[], names: string[], read: (p: string) => string | undefined = (p) => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return undefined;
  }
}): Record<string, { count: number; hits: string[] }> {
  const out: Record<string, { count: number; hits: string[] }> = {};
  const escape = (n: string) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regexes: RegExp[] = [];
  if (names.length) regexes.push(new RegExp(names.map(escape).join("|"), "gi"));
  for (const p of PATTERNS) regexes.push(new RegExp(p.source, "g"));
  for (const path of files) {
    if (isExcluded(path)) continue;
    const text = read(path);
    if (text === undefined) continue;
    let count = 0;
    const hits: string[] = [];
    for (const re of regexes) {
      for (const m of text.matchAll(re)) {
        count++;
        if (hits.length < 5) hits.push(m[0]);
      }
    }
    if (count > 0) out[path] = { count, hits };
  }
  return out;
}

function trackedFiles(): string[] {
  return execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n").filter(Boolean);
}

function main() {
  const update = process.argv.includes("--update");
  const names = discoveredNames();
  const counts = countNames(trackedFiles(), names);
  const hasBaseline = existsSync(BASELINE);
  const baseline: Record<string, number> = hasBaseline ? JSON.parse(readFileSync(BASELINE, "utf8")).files ?? {} : {};
  if (!hasBaseline && !update) {
    console.error(`zero-names: no baseline at ${BASELINE}; create it once with --update`);
    process.exit(1);
  }

  const worse: string[] = [];
  const better: string[] = [];
  for (const [path, { count, hits }] of Object.entries(counts)) {
    const allowed = baseline[path] ?? 0;
    if (count > allowed) worse.push(`${path}: ${count} (allowed ${allowed}) e.g. ${hits.join(", ")}`);
    else if (count < allowed) better.push(path);
  }
  for (const path of Object.keys(baseline)) if (!counts[path]) better.push(path);

  const total = Object.values(counts).reduce((s, v) => s + v.count, 0);
  const allowedTotal = Object.values(baseline).reduce((s, v) => s + v, 0);
  console.log(`zero-names: ${total} name(s) in ${Object.keys(counts).length} file(s); baseline ${allowedTotal} in ${Object.keys(baseline).length} file(s); denylist ${names.length} discovered name(s)`);

  if (update) {
    if (hasBaseline && worse.length) {
      console.error("zero-names: refusing to raise the baseline:\n  " + worse.join("\n  "));
      process.exit(1);
    }
    const next: Record<string, number> = {};
    for (const [path, { count }] of Object.entries(counts)) next[path] = count;
    writeFileSync(BASELINE, JSON.stringify({ version: 1, note: "file paths and counts only; the names come from discovery", files: next }, null, 2) + "\n");
    console.log(`zero-names: baseline lowered to ${total} name(s) in ${Object.keys(next).length} file(s)`);
    return;
  }
  if (worse.length) {
    console.error("zero-names: new or increased names:\n  " + worse.join("\n  "));
    console.error("Remove them, or run with --update once the count has gone down.");
    process.exit(1);
  }
  if (better.length) console.log(`zero-names: ${better.length} file(s) are below baseline; run with --update to lock in the gain`);
  console.log("zero-names: PASS");
}

if (process.argv[1]?.endsWith("check-zero-names.mts")) main();
