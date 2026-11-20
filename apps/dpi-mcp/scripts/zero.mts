// The zero bootstrap, one command:
//
//   npx tsx apps/dpi-mcp/scripts/zero.mts            # the dialog: defaults pre-checked, Enter submits
//   npx tsx apps/dpi-mcp/scripts/zero.mts --yes      # no dialog: take the defaults (every local model)
//
// Hosts come from mesh.json (Cloudflare Tunnel + Access); tokens from ~/.dpi-mcp/access.env. Nothing here
// names a host or a model. See src/zero.ts for the logic and the realized-cost rules.
import { createInterface } from "node:readline";
import { discoverMeshModels } from "../src/mesh.js";
import { bootstrap, parseSelection, type Candidate } from "../src/zero.js";
import { fetchCatalog } from "../src/cloud-catalog.js";

const yes = process.argv.includes("--yes");

/** The dialog: a numbered checklist, defaults pre-checked. Enter submits; numbers toggle; a/n = all/none. */
async function dialog(candidates: Candidate[], defaults: boolean[]): Promise<boolean[]> {
  if (yes) return defaults;
  console.log("\nWhich local models do you want to enable for the start?  [x] = auto-selected");
  candidates.forEach((c, i) => console.log(`  ${defaults[i] ? "[x]" : "[ ]"} ${String(i + 1).padStart(2)}. ${c.id.padEnd(44)} ${c.kind.padEnd(8)} on ${c.host}`));
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    let answered = false;
    rl.question("\nEnter = submit the [x] set · numbers toggle · a = all · n = none: ", (answer) => {
      answered = true;
      rl.close();
      resolve(parseSelection(answer, candidates.length, defaults));
    });
    rl.on("close", () => {
      if (!answered) resolve(defaults); // stdin closed with no answer: submit the auto-selection
    });
  });
}

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
const report = await bootstrap({
  discover: () => discoverMeshModels(),
  choose: dialog,
  log: (line) => console.log(line),
  cloud: accountId
    ? { models: () => fetchCatalog(), address: `https://api.cloudflare.com/client/v4/accounts/${accountId}` }
    : undefined,
});
process.exit(report.allTested ? 0 : 1);
