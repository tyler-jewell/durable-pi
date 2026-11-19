// Stamps the .tsf factory into a target directory (default: the current directory).
//   npx tsx scripts/tsf-install.mts [target-dir]
// Idempotent: existing files are skipped, so a second run doubles as a drift check.
import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE = join(ROOT, "templates", "tsf");
const target = resolve(process.argv[2] ?? ".");
const dest = join(target, ".tsf");

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

let copied = 0;
let skipped = 0;
for (const src of walk(TEMPLATE)) {
  const rel = relative(TEMPLATE, src);
  const out = join(dest, rel);
  if (existsSync(out)) {
    skipped++;
    continue;
  }
  mkdirSync(dirname(out), { recursive: true });
  cpSync(src, out);
  copied++;
}
console.log(`tsf: stamped .tsf/ into ${target} (${copied} files, ${skipped} skipped)`);
