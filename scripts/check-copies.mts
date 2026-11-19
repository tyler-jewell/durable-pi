// Declared copies of shared files must stay byte-identical. Apps are separate packages (the base app is the shell each
// Durable Object app ships, so it cannot import from the hub), which makes a copy deliberate. A copy that drifts is a
// bug nobody sees, so each one is declared here with the file it follows, and this check fails when they differ.
//
//   node scripts/check-copies.mts        (what `just copies` runs, and `just check`)
//
// Files that started as copies and then diverged on purpose (base-app and playground JobCard.vue and TranscriptItem.vue)
// are not listed: they are no longer the same file.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** `source` is the file to edit; every file in `copies` must equal it. */
const COPIES: Array<{ source: string; copies: string[]; why: string }> = [
  {
    source: "apps/dpi-playground/apps/dpi-playground-fe/src/components/StateEditor.vue",
    copies: ["apps/base-app/src/left/StateEditor.vue"],
    why: "the base app is the shell a Durable Object app ships, so it carries its own copy of the hub's editor",
  },
  {
    source: "apps/dpi-playground/apps/dpi-playground-fe/src/client/markdown.ts",
    copies: ["apps/base-app/src/left/markdown.ts"],
    why: "the same shell, the same markdown renderer",
  },
];

const read = (path: string) => readFileSync(join(root, path), "utf8");
let drifted = 0;
for (const { source, copies, why } of COPIES) {
  const want = read(source);
  for (const copy of copies) {
    if (read(copy) === want) continue;
    drifted += 1;
    console.error(`copies: ${copy} differs from ${source}\n        (${why})\n        edit the source, then: cp ${source} ${copy}`);
  }
}
if (drifted > 0) process.exit(1);
console.log(`copies: ${COPIES.reduce((n, c) => n + c.copies.length, 0)} declared copies match their sources`);
